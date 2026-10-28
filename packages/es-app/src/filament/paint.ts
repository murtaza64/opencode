/* Two painters sharing one primitive list (glowing capsules, rings, dots) so the scene is
 * backend-agnostic. WebGL2 draws every primitive as one instanced SDF quad batch; Canvas2D
 * strokes the same list with layered alpha (no shadowBlur, which is CPU-bound). */
export type RGBA = readonly [number, number, number, number]
export type Painter = {
  kind: string
  begin(w: number, h: number, scale: number): void
  capsule(x0: number, y0: number, x1: number, y1: number, width: number, rgba: RGBA, glow?: number): void
  ring(cx: number, cy: number, r: number, thick: number, rgba: RGBA, glow?: number, a0?: number, a1?: number): void
  dot(cx: number, cy: number, r: number, rgba: RGBA, glow?: number): void
  flush(): void
  count(): number
  destroy(): void
}

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2 corner; layout(location=1) in vec4 seg; layout(location=2) in vec4 col;
layout(location=3) in vec3 par; layout(location=4) in vec3 arc;
uniform vec2 res;
out vec2 p; flat out vec4 vcol; flat out vec3 vpar; flat out vec4 vseg; flat out vec3 varc;
void main(){
  // The glow kernel is windowed to zero at 4.6*glow (see frag), so the quad pads exactly that far.
  vec2 a = seg.xy, b = seg.zw; float pad = par.x*0.5 + par.y*4.6 + 2.0; vec2 lo, hi;
  if (par.z < 0.5) { lo = min(a,b) - pad; hi = max(a,b) + pad; } else { float r = arc.x + pad; lo = a - r; hi = a + r; }
  vec2 pos = mix(lo, hi, corner); p = pos; vcol = col; vpar = par; vseg = seg; varc = arc;
  vec2 clip = pos / res * 2.0 - 1.0; gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`
const FRAG = `#version 300 es
precision highp float;
in vec2 p; flat in vec4 vcol; flat in vec3 vpar; flat in vec4 vseg; flat in vec3 varc; out vec4 o;
float sdSeg(vec2 p, vec2 a, vec2 b){ vec2 pa=p-a, ba=b-a; float h=clamp(dot(pa,ba)/max(dot(ba,ba),1e-4),0.0,1.0); return length(pa-ba*h); }
void main(){
  float d;
  if (vpar.z < 0.5) d = sdSeg(p, vseg.xy, vseg.zw) - vpar.x*0.5;
  else {
    vec2 q = p - vseg.xy; d = abs(length(q) - varc.x) - vpar.x*0.5;
    if (varc.z - varc.y < 6.2831) {
      float rel = mod(atan(q.y, q.x) - varc.y, 6.2831853); float span = mod(varc.z - varc.y, 6.2831853);
      if (rel > span) { vec2 e0 = vseg.xy + varc.x*vec2(cos(varc.y),sin(varc.y)), e1 = vseg.xy + varc.x*vec2(cos(varc.z),sin(varc.z));
        d = min(length(p-e0), length(p-e1)) - vpar.x*0.5; }
    }
  }
  float core = 1.0 - smoothstep(-0.75, 0.75, d);
  // Exponential falloff multiplied by a smooth window that reaches exactly zero before the quad
  // edge, so no glow is clipped into a visible rectangle.
  float reach = vpar.y * 4.6;
  float window = vpar.y > 0.0 ? 1.0 - smoothstep(reach * 0.55, reach, max(d, 0.0)) : 0.0;
  float glow = vpar.y > 0.0 ? exp(-max(d,0.0)/vpar.y) * 0.55 * window : 0.0;
  float a = clamp(core + glow, 0.0, 1.0) * vcol.a; o = vec4(vcol.rgb * a, a);
}`

export const createPainter = (canvas: HTMLCanvasElement, backend: "webgl2" | "canvas2d"): Painter => {
  const MAX = 4096
  const inst = new Float32Array(14 * MAX)
  let n = 0
  let res = { w: 1, h: 1, scale: 1 }
  const push = (seg: number[], col: RGBA, par: number[], arc: number[]) => {
    if (n >= MAX) return
    inst.set([...seg, ...col, ...par, ...arc], n * 14)
    n++
  }
  const base = {
    begin(w: number, h: number, scale: number) { res = { w, h, scale }; n = 0 },
    capsule(x0: number, y0: number, x1: number, y1: number, width: number, rgba: RGBA, glow = 0) { push([x0, y0, x1, y1], rgba, [width, glow, 0], [0, 0, 0]) },
    ring(cx: number, cy: number, r: number, thick: number, rgba: RGBA, glow = 0, a0 = 0, a1 = Math.PI * 2) { push([cx, cy, cx, cy], rgba, [thick, glow, 1], [r, a0, a1]) },
    dot(cx: number, cy: number, r: number, rgba: RGBA, glow = 0) { push([cx, cy, cx, cy], rgba, [r * 2, glow, 0], [0, 0, 0]) },
    count: () => n,
  }
  if (backend === "webgl2") {
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: "low-power" })
    if (!gl) throw new Error("webgl2 context unavailable")
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader")
      return s
    }
    const prog = gl.createProgram()!
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT))
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link")
    const vao = gl.createVertexArray()
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    const ibuf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, ibuf)
    gl.bufferData(gl.ARRAY_BUFFER, inst.byteLength, gl.DYNAMIC_DRAW)
    const attr = (loc: number, size: number, off: number) => {
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 14 * 4, off * 4)
      gl.vertexAttribDivisor(loc, 1)
    }
    attr(1, 4, 0); attr(2, 4, 4); attr(3, 3, 8); attr(4, 3, 11)
    const uRes = gl.getUniformLocation(prog, "res")
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    return {
      ...base,
      kind: "webgl2 instanced SDF",
      flush() {
        gl.viewport(0, 0, canvas.width, canvas.height)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        if (!n) return
        gl.useProgram(prog)
        gl.bindVertexArray(vao)
        gl.uniform2f(uRes, res.w, res.h)
        gl.bindBuffer(gl.ARRAY_BUFFER, ibuf)
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, inst, 0, n * 14)
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n)
      },
      destroy: () => gl.getExtension("WEBGL_lose_context")?.loseContext(),
    }
  }
  const ctx = canvas.getContext("2d")!
  const css = (c: RGBA, a: number) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`
  return {
    ...base,
    kind: "canvas2d layered strokes",
    flush() {
      ctx.setTransform(res.scale, 0, 0, res.scale, 0, 0)
      ctx.clearRect(0, 0, res.w, res.h)
      ctx.lineCap = "round"
      for (let i = 0; i < n; i++) {
        const o = i * 14
        const x0 = inst[o]!, y0 = inst[o + 1]!, x1 = inst[o + 2]!, y1 = inst[o + 3]!
        const col: RGBA = [inst[o + 4]!, inst[o + 5]!, inst[o + 6]!, 1]
        const alpha = inst[o + 7]!, width = inst[o + 8]!, glow = inst[o + 9]!, mode = inst[o + 10]!
        const r = inst[o + 11]!, a0 = inst[o + 12]!, a1 = inst[o + 13]!
        const stroke = (w: number, a: number) => {
          ctx.strokeStyle = css(col, a)
          ctx.lineWidth = w
          ctx.beginPath()
          if (mode < 0.5) {
            if (x0 === x1 && y0 === y1) {
              ctx.arc(x0, y0, Math.max(0.01, w / 2), 0, Math.PI * 2)
              ctx.fillStyle = css(col, a)
              ctx.fill()
              return
            }
            ctx.moveTo(x0, y0)
            ctx.lineTo(x1, y1)
          } else ctx.arc(x0, y0, r, a0, a1)
          ctx.stroke()
        }
        if (glow > 0) { stroke(width + glow * 4.6, alpha * 0.04); stroke(width + glow * 3, alpha * 0.08); stroke(width + glow * 1.6, alpha * 0.14); stroke(width + glow * 0.8, alpha * 0.2) }
        stroke(width, alpha)
      }
    },
    destroy() {},
  }
}

// Honest backend choice: a WebGL2 context that would run on a software rasterizer is refused.
export const chooseBackend = (): { backend: "webgl2" | "canvas2d"; renderer: string } => {
  const probe = document.createElement("canvas")
  const gl = probe.getContext("webgl2", { failIfMajorPerformanceCaveat: true, powerPreference: "low-power" })
  if (!gl) return { backend: "canvas2d", renderer: "no hardware WebGL2 (caveat or unsupported)" }
  const dbg = gl.getExtension("WEBGL_debug_renderer_info")
  const renderer = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
  gl.getExtension("WEBGL_lose_context")?.loseContext()
  if (/swiftshader|llvmpipe|softpipe|software/i.test(renderer)) return { backend: "canvas2d", renderer }
  return { backend: "webgl2", renderer }
}
