package ai.opencode.editspace;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.inputmethod.EditorInfo;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/**
 * Thin client for es-app. The host-side gateway serves the UI and proxies the
 * OpenCode/dashboard APIs; this shell only connects, pairs, and reports
 * connection failures. Nothing executes on the device.
 */
public class MainActivity extends Activity {
  private static final String PREFS = "editspace";
  private static final String ENDPOINT = "endpoint";
  private static final int FILE_REQUEST = 1;
  private static final int BACKGROUND = Color.rgb(0x17, 0x18, 0x19);
  private static final int TEXT = Color.rgb(0xec, 0xec, 0xec);
  private static final int MUTED = Color.rgb(0xa8, 0xa8, 0xa8);
  private static final int ERROR = Color.rgb(0xff, 0x9b, 0x8f);

  private WebView web;
  private View connectPanel;
  private View errorPanel;
  private EditText endpointInput;
  private EditText codeInput;
  private TextView connectStatus;
  private Button connectButton;
  private Button forgetButton;
  private TextView errorMessage;
  private String endpoint;
  private String failedUrl;
  private ValueCallback<Uri[]> fileCallback;

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);
    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(BACKGROUND);
    // targetSdk 35 draws edge to edge: keep content clear of system bars and the keyboard.
    root.setOnApplyWindowInsetsListener((view, insets) -> {
      Insets inset = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
      view.setPadding(inset.left, inset.top, inset.right, inset.bottom);
      return WindowInsets.CONSUMED;
    });
    web = createWebView();
    connectPanel = createConnectPanel();
    errorPanel = createErrorPanel();
    root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    root.addView(connectPanel);
    root.addView(errorPanel);
    setContentView(root);

    endpoint = prefs().getString(ENDPOINT, null);
    if (endpoint == null) {
      showConnect("");
      return;
    }
    endpointInput.setText(endpoint);
    String restored = state == null ? null : state.getString("url");
    showWeb();
    web.loadUrl(restored != null && sameOrigin(restored) ? restored : endpoint);
  }

  private WebView createWebView() {
    WebView view = new WebView(this);
    view.setBackgroundColor(BACKGROUND);
    WebSettings settings = view.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);
    settings.setGeolocationEnabled(false);
    settings.setSupportMultipleWindows(false);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    // es-app keeps composer drafts in durable storage only for native shells.
    settings.setUserAgentString(settings.getUserAgentString() + " EditspaceAndroid/0.1");
    CookieManager.getInstance().setAcceptCookie(true);
    view.setWebViewClient(new WebViewClient() {
      @Override
      public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        if (sameOrigin(uri.toString())) return false;
        String scheme = uri.getScheme();
        if ("http".equals(scheme) || "https".equals(scheme)) {
          try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
          } catch (ActivityNotFoundException ignored) {
            // No browser installed; the link simply does nothing.
          }
        }
        return true;
      }

      @Override
      public void onPageFinished(WebView view, String url) {
        // Error callbacks may arrive before onPageStarted, so the failed URL (not a
        // per-load flag) decides whether the native panel stays up.
        if (url != null && !url.equals(failedUrl) && sameOrigin(url)) showWeb();
        // Persist the pairing cookie promptly; the process can die without onPause.
        CookieManager.getInstance().flush();
      }

      @Override
      public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (!request.isForMainFrame()) return;
        failedUrl = request.getUrl().toString();
        showError(endpoint + " isn't responding. Check that the gateway is running; over USB, rerun adb reverse.");
      }

      @Override
      public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
        if (!request.isForMainFrame()) return;
        failedUrl = request.getUrl().toString();
        int status = response.getStatusCode();
        boolean pairing = "/__es/pair".equals(request.getUrl().getPath());
        if (status == 401) showConnect(pairing ? "That code does not match." : "Pair this device to continue.");
        else if (status == 429) showConnect("Too many attempts. Wait a minute, then try again.");
        else if (status == 403) showConnect("The gateway refused this address. Use the exact address it printed.");
        else if (status == 503) showError("The gateway is running, but OpenCode or the dashboard is not responding on your computer.");
        else showError("The gateway returned HTTP " + status + ".");
      }
    });
    view.setWebChromeClient(new WebChromeClient() {
      @Override
      public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        fileCallback = callback;
        try {
          startActivityForResult(params.createIntent(), FILE_REQUEST);
          return true;
        } catch (ActivityNotFoundException error) {
          fileCallback = null;
          return false;
        }
      }
    });
    return view;
  }

  private View createConnectPanel() {
    LinearLayout column = column();
    column.addView(text("Connect to Editspace", 22, TEXT, true));
    column.addView(spaced(text("Start the gateway on your computer, then enter the address and pairing code it prints.", 16, MUTED, false), 8, 24));
    endpointInput = input("http://127.0.0.1:47120", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
    column.addView(label("Gateway address", endpointInput));
    column.addView(spaced(endpointInput, 6, 16));
    codeInput = input("Leave empty if already paired", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
    column.addView(label("Pairing code", codeInput));
    codeInput.setImeOptions(EditorInfo.IME_ACTION_GO);
    codeInput.setOnEditorActionListener((view, action, event) -> {
      connect();
      return true;
    });
    column.addView(spaced(codeInput, 6, 0));
    connectStatus = text("", 14, ERROR, false);
    connectStatus.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
    column.addView(spaced(connectStatus, 12, 0));
    connectButton = button("Connect", true);
    connectButton.setOnClickListener(view -> connect());
    column.addView(spaced(connectButton, 12, 0));
    forgetButton = button("Forget this gateway", false);
    forgetButton.setOnClickListener(view -> forget());
    column.addView(spaced(forgetButton, 8, 0));
    ScrollView scroll = new ScrollView(this);
    scroll.setFillViewport(true);
    scroll.setBackgroundColor(BACKGROUND);
    scroll.addView(column);
    return scroll;
  }

  private View createErrorPanel() {
    LinearLayout column = column();
    column.setBackgroundColor(BACKGROUND);
    column.addView(text("Can't reach Editspace", 22, TEXT, true));
    errorMessage = text("", 16, MUTED, false);
    errorMessage.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
    column.addView(spaced(errorMessage, 8, 24));
    Button retry = button("Retry", true);
    retry.setOnClickListener(view -> {
      String target = failedUrl != null && sameOrigin(failedUrl) && !failedUrl.endsWith("/__es/pair") ? failedUrl : endpoint;
      failedUrl = null;
      web.loadUrl(target);
    });
    column.addView(retry);
    Button change = button("Change gateway", false);
    change.setOnClickListener(view -> showConnect(""));
    column.addView(spaced(change, 8, 0));
    return column;
  }

  private void connect() {
    String target;
    try {
      target = normalizeEndpoint(endpointInput.getText().toString());
    } catch (IllegalArgumentException error) {
      connectStatus.setText(error.getMessage());
      return;
    }
    String code = codeInput.getText().toString().trim();
    connectButton.setEnabled(false);
    connectStatus.setText("");
    new Thread(() -> {
      String failure = probe(target);
      runOnUiThread(() -> {
        connectButton.setEnabled(true);
        if (failure != null) {
          connectStatus.setText(failure);
          return;
        }
        endpoint = target;
        endpointInput.setText(target);
        prefs().edit().putString(ENDPOINT, target).apply();
        codeInput.setText("");
        failedUrl = null;
        if (code.isEmpty()) web.loadUrl(target);
        else web.postUrl(target + "/__es/pair", ("code=" + URLEncoder.encode(code, StandardCharsets.UTF_8)).getBytes(StandardCharsets.UTF_8));
      });
    }).start();
  }

  /** Returns a user-facing failure, or null when the address is an Editspace gateway. */
  private static String probe(String target) {
    HttpURLConnection connection = null;
    try {
      connection = (HttpURLConnection) new URL(target + "/__es/health").openConnection();
      connection.setConnectTimeout(4000);
      connection.setReadTimeout(4000);
      connection.setInstanceFollowRedirects(false);
      if (connection.getResponseCode() != 200) return target + " is not an Editspace gateway (HTTP " + connection.getResponseCode() + ").";
      try (InputStream body = connection.getInputStream()) {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        byte[] buffer = new byte[512];
        for (int read; (read = body.read(buffer)) != -1 && bytes.size() < 4096; ) bytes.write(buffer, 0, read);
        if (!bytes.toString(StandardCharsets.UTF_8.name()).contains("\"service\":\"editspace\"")) return target + " is not an Editspace gateway.";
      }
      return null;
    } catch (ConnectException error) {
      return "Nothing is listening at " + target + ". Start the gateway; over USB also run adb reverse.";
    } catch (SocketTimeoutException error) {
      return target + " did not respond.";
    } catch (Exception error) {
      return "Can't reach " + target + ": " + error.getMessage();
    } finally {
      if (connection != null) connection.disconnect();
    }
  }

  /**
   * Plain http carries the pairing cookie, so it is accepted only for loopback
   * (adb reverse) and tailnet addresses, matching the gateway's bind policy.
   */
  static String normalizeEndpoint(String raw) {
    String value = raw.trim();
    if (value.isEmpty()) throw new IllegalArgumentException("Enter the gateway address.");
    if (!value.contains("://")) value = "http://" + value;
    URI uri;
    try {
      uri = new URI(value);
    } catch (Exception error) {
      throw new IllegalArgumentException("That address is not valid.");
    }
    String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
    String host = uri.getHost() == null ? "" : uri.getHost().replaceAll("^\\[|\\]$", "").toLowerCase();
    if (host.equals("localhost")) host = "127.0.0.1";
    if (host.isEmpty() || uri.getUserInfo() != null || !(scheme.equals("http") || scheme.equals("https")))
      throw new IllegalArgumentException("Use an http:// or https:// gateway address.");
    if (scheme.equals("http") && !privateHost(host))
      throw new IllegalArgumentException("Plain http works only with 127.0.0.1 (adb reverse) or a tailnet address.");
    return scheme + "://" + (host.contains(":") ? "[" + host + "]" : host) + (uri.getPort() == -1 ? "" : ":" + uri.getPort());
  }

  static boolean privateHost(String host) {
    if (host.equals("::1") || host.startsWith("fd7a:115c:a1e0:")) return true;
    String[] parts = host.split("\\.");
    if (parts.length != 4) return false;
    try {
      int a = Integer.parseInt(parts[0]);
      int b = Integer.parseInt(parts[1]);
      return a == 127 || (a == 100 && b >= 64 && b <= 127);
    } catch (NumberFormatException error) {
      return false;
    }
  }

  private boolean sameOrigin(String url) {
    if (endpoint == null || url == null) return false;
    try {
      URI target = new URI(url);
      URI base = new URI(endpoint);
      return base.getScheme().equalsIgnoreCase(target.getScheme())
          && base.getHost().equalsIgnoreCase(target.getHost())
          && port(base) == port(target);
    } catch (Exception error) {
      return false;
    }
  }

  private static int port(URI uri) {
    if (uri.getPort() != -1) return uri.getPort();
    return "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
  }

  private void forget() {
    CookieManager.getInstance().removeAllCookies(null);
    CookieManager.getInstance().flush();
    prefs().edit().remove(ENDPOINT).apply();
    endpoint = null;
    web.loadUrl("about:blank");
    showConnect("This device is no longer paired. Saved drafts stay on the device.");
  }

  private void showWeb() {
    web.setVisibility(View.VISIBLE);
    connectPanel.setVisibility(View.GONE);
    errorPanel.setVisibility(View.GONE);
  }

  private void showConnect(String message) {
    connectStatus.setText(message);
    forgetButton.setVisibility(endpoint == null ? View.GONE : View.VISIBLE);
    connectPanel.setVisibility(View.VISIBLE);
    errorPanel.setVisibility(View.GONE);
    web.setVisibility(View.GONE);
  }

  private void showError(String message) {
    errorMessage.setText(message);
    errorPanel.setVisibility(View.VISIBLE);
    connectPanel.setVisibility(View.GONE);
    web.setVisibility(View.GONE);
  }

  @SuppressWarnings("deprecation")
  @Override
  public void onBackPressed() {
    if (web.getVisibility() == View.VISIBLE && web.canGoBack()) {
      web.goBack();
      return;
    }
    if (web.getVisibility() == View.VISIBLE) {
      showConnect("");
      return;
    }
    super.onBackPressed();
  }

  @SuppressWarnings("deprecation")
  @Override
  protected void onActivityResult(int request, int result, Intent data) {
    if (request != FILE_REQUEST || fileCallback == null) {
      super.onActivityResult(request, result, data);
      return;
    }
    fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
    fileCallback = null;
  }

  @Override
  protected void onSaveInstanceState(Bundle state) {
    super.onSaveInstanceState(state);
    if (sameOrigin(web.getUrl())) state.putString("url", web.getUrl());
  }

  @Override
  protected void onPause() {
    super.onPause();
    web.onPause();
    CookieManager.getInstance().flush();
  }

  @Override
  protected void onResume() {
    super.onResume();
    web.onResume();
  }

  @Override
  protected void onDestroy() {
    web.destroy();
    super.onDestroy();
  }

  private SharedPreferences prefs() {
    return getSharedPreferences(PREFS, MODE_PRIVATE);
  }

  private int dp(int value) {
    return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
  }

  private LinearLayout column() {
    LinearLayout column = new LinearLayout(this);
    column.setOrientation(LinearLayout.VERTICAL);
    column.setGravity(Gravity.CENTER_VERTICAL);
    column.setPaddingRelative(dp(24), dp(32), dp(24), dp(32));
    return column;
  }

  private TextView text(String value, int size, int color, boolean bold) {
    TextView view = new TextView(this);
    view.setText(value);
    view.setTextSize(TypedValue.COMPLEX_UNIT_SP, size);
    view.setTextColor(color);
    view.setTextAlignment(View.TEXT_ALIGNMENT_VIEW_START);
    if (bold) view.setTypeface(Typeface.DEFAULT_BOLD);
    return view;
  }

  private TextView label(String value, View target) {
    TextView view = text(value, 14, TEXT, false);
    view.setLabelFor(target.getId());
    return view;
  }

  private EditText input(String hint, int type) {
    EditText view = new EditText(this);
    view.setId(View.generateViewId());
    view.setHint(hint);
    view.setInputType(type);
    view.setSingleLine(true);
    view.setTextColor(TEXT);
    view.setHintTextColor(MUTED);
    // Addresses and codes read left to right even in RTL layouts.
    view.setTextDirection(View.TEXT_DIRECTION_LTR);
    view.setTextAlignment(View.TEXT_ALIGNMENT_VIEW_START);
    return view;
  }

  private Button button(String label, boolean primary) {
    Button view = new Button(this, null, primary ? android.R.attr.buttonStyle : android.R.attr.borderlessButtonStyle);
    view.setText(label);
    view.setAllCaps(false);
    view.setMinHeight(dp(48));
    return view;
  }

  private <T extends View> T spaced(T view, int before, int after) {
    LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    params.topMargin = dp(before);
    params.bottomMargin = dp(after);
    view.setLayoutParams(params);
    return view;
  }
}
