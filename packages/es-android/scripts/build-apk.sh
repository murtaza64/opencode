#!/bin/sh
# Builds a debug-signed APK with SDK build-tools directly (no Gradle): the shell
# is one Activity with no resources or third-party dependencies.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}
platform=${ES_ANDROID_PLATFORM:-35}
tools=${ES_ANDROID_BUILD_TOOLS:-$(ls "$sdk/build-tools" | sort -V | tail -1)}
if [ -z "${JAVA_HOME:-}" ]; then
  for candidate in /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home /usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home; do
    [ -x "$candidate/bin/javac" ] && JAVA_HOME=$candidate && break
  done
fi
[ -n "${JAVA_HOME:-}" ] || { echo "JDK 17 not found; set JAVA_HOME" >&2; exit 1; }
export JAVA_HOME PATH="$JAVA_HOME/bin:$PATH"
jar="$sdk/platforms/android-$platform/android.jar"
bt="$sdk/build-tools/$tools"
[ -f "$jar" ] || { echo "Missing $jar (sdkmanager 'platforms;android-$platform')" >&2; exit 1; }
[ -x "$bt/aapt2" ] || { echo "Missing build-tools in $bt" >&2; exit 1; }

build="$root/build"
out="$root/dist/editspace-debug.apk"
rm -rf "$build/classes" "$build/dex" "$build/unsigned.apk" "$build/aligned.apk"
mkdir -p "$build/classes" "$build/dex" "$root/dist"

"$bt/aapt2" link -o "$build/unsigned.apk" -I "$jar" \
  --manifest "$root/android/AndroidManifest.xml" \
  --min-sdk-version 30 --target-sdk-version "$platform" \
  --version-code 1 --version-name 0.1.0 --debug-mode
find "$root/android/src" -name '*.java' > "$build/sources.txt"
javac --release 11 -Xlint:-options -encoding UTF-8 -classpath "$jar" -d "$build/classes" @"$build/sources.txt"
"$bt/d8" --release --min-api 30 --lib "$jar" --output "$build/dex" $(find "$build/classes" -name '*.class')
(cd "$build/dex" && zip -q -j "$build/unsigned.apk" classes.dex)
"$bt/zipalign" -p -f 4 "$build/unsigned.apk" "$build/aligned.apk"

# Lane-local debug key: the APK is a prototype and is never published.
keystore="$build/debug.keystore"
[ -f "$keystore" ] || keytool -genkeypair -keystore "$keystore" -storepass android -keypass android \
  -alias editspace-debug -keyalg RSA -keysize 2048 -validity 3650 -dname "CN=Editspace Debug" >/dev/null 2>&1
"$bt/apksigner" sign --ks "$keystore" --ks-pass pass:android --key-pass pass:android --out "$out" "$build/aligned.apk"
"$bt/apksigner" verify "$out"
echo "$out"
