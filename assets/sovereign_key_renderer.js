// Veristrux Plate 01 — Ultra-Fast Zero-Dependency WebGL2 PBR 360° Orbital Renderer
// Pre-bakes 360° candlelit sanctuary bokeh & mipmapped HDR IBL once at startup (<2 ms),
// renders with hardware Early-Z, zero per-frame DOM reflows, and zero per-frame allocations.
(function () {
  "use strict";

  function initSovereignKeyStage() {
    var stageData = window.VERISTRUX_KEY_STAGE;
    var canvas = document.getElementById("sovereign-key-canvas");
    var plate = document.getElementById("sovereign-plate");
    if (!stageData || !canvas || !plate) return;

    var gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: true,
      depth: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false
    });
    if (!gl) return;

    // ------------------------------------------------------------------
    // 1. Decode quantized 12-byte vertex buffer (<hhhbbbBBB)
    // ------------------------------------------------------------------
    var binStr = atob(stageData.b64);
    var byteLen = binStr.length;
    var rawBytes = new Uint8Array(byteLen);
    for (var i = 0; i < byteLen; i++) rawBytes[i] = binStr.charCodeAt(i);

    var dv = new DataView(rawBytes.buffer);
    var vCount = stageData.vertexCount | 0;
    var stride = stageData.strideBytes | 0;
    var posFactor = stageData.posScale / 32767.0;

    var vboData = new Float32Array(vCount * 9);
    for (var v = 0; v < vCount; v++) {
      var off = v * stride;
      var ix = dv.getInt16(off + 0, true);
      var iy = dv.getInt16(off + 2, true);
      var iz = dv.getInt16(off + 4, true);
      var inx = dv.getInt8(off + 6);
      var iny = dv.getInt8(off + 7);
      var inz = dv.getInt8(off + 8);
      var iu = dv.getUint8(off + 9);
      var iv = dv.getUint8(off + 10);
      var mat = dv.getUint8(off + 11);

      var nx = inx / 127.0;
      var ny = iny / 127.0;
      var nz = inz / 127.0;
      var nLen = Math.hypot(nx, ny, nz) || 1.0;

      var dst = v * 9;
      vboData[dst + 0] = ix * posFactor;
      vboData[dst + 1] = iy * posFactor;
      vboData[dst + 2] = iz * posFactor;
      vboData[dst + 3] = nx / nLen;
      vboData[dst + 4] = ny / nLen;
      vboData[dst + 5] = nz / nLen;
      vboData[dst + 6] = iu / 255.0;
      vboData[dst + 7] = iv / 255.0;
      vboData[dst + 8] = mat;
    }

    // ------------------------------------------------------------------
    // 2. Shader compilation helpers
    // ------------------------------------------------------------------
    function compileShader(type, src) {
      var sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error("Veristrux WebGL2 shader error:", gl.getShaderInfoLog(sh));
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    }

    function createProgram(vsSrc, fsSrc) {
      var vs = compileShader(gl.VERTEX_SHADER, vsSrc);
      var fs = compileShader(gl.FRAGMENT_SHADER, fsSrc);
      if (!vs || !fs) return null;
      var prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error("Veristrux WebGL2 link error:", gl.getProgramInfoLog(prog));
        gl.deleteProgram(prog);
        return null;
      }
      return prog;
    }

    var fullTriVS = [
      "#version 300 es",
      "out vec2 v_ndc;",
      "void main() {",
      "  vec2 p = vec2((gl_VertexID == 1) ? 3.0 : -1.0, (gl_VertexID == 2) ? 3.0 : -1.0);",
      "  v_ndc = p;",
      "  gl_Position = vec4(p, 1.0, 1.0);",
      "}"
    ].join("\n");

    // ------------------------------------------------------------------
    // 3. One-Time Bake Shaders: (A) 360° Bokeh Sanctuary, (B) 360° HDR IBL
    // ------------------------------------------------------------------
    var bakeBgFS = [
      "#version 300 es",
      "precision highp float;",
      "in vec2 v_ndc;",
      "out vec4 outColor;",
      "const float PI = 3.14159265359;",
      "void main() {",
      "  vec2 uv = v_ndc * 0.5 + 0.5;",
      "  float az = (uv.x - 0.5) * 2.0 * PI;",
      "  float el = sin((uv.y - 0.5) * PI);",
      "  vec3 zenith = vec3(0.0035, 0.0030, 0.0040);",
      "  vec3 horizon = vec3(0.017, 0.0095, 0.0065);",
      "  vec3 floorCol = vec3(0.0030, 0.0022, 0.0026);",
      "  float hBand = exp(-pow((el + 0.03) * 4.2, 2.0));",
      "  vec3 col = mix(el >= 0.0 ? zenith : floorCol, horizon, hBand);",
      "  float pillar = pow(max(0.0, cos(az * 6.0)), 14.0) * smoothstep(-0.30, 0.45, el);",
      "  col += vec3(0.009, 0.0055, 0.0038) * pillar * (1.0 - abs(el));",
      "  for (int i = 0; i < 16; i++) {",
      "    float fi = float(i);",
      "    float a0 = fi * 0.392699 + sin(fi * 2.13) * 0.14;",
      "    float e0 = -0.34 + fract(fi * 0.371) * 0.25;",
      "    float dAz = atan(sin(az - a0), cos(az - a0));",
      "    float dEl = el - e0;",
      "    float rad = 0.026 + fract(fi * 0.618) * 0.056;",
      "    float dist = length(vec2(dAz, dEl * 1.08));",
      "    float disc = smoothstep(rad, rad * 0.24, dist);",
      "    float ring = exp(-pow((dist - rad * 0.80) / (rad * 0.18), 2.0)) * 0.28;",
      "    float halo = exp(-pow(dist / (rad * 2.3), 2.0)) * 0.22;",
      "    vec3 warm = mix(vec3(1.20, 0.46, 0.10), vec3(1.42, 0.86, 0.32), fract(fi * 0.41));",
      "    float intensity = 0.065 + 0.135 * fract(fi * 0.77);",
      "    col += warm * (disc * 0.42 + ring + halo) * intensity;",
      "  }",
      "  outColor = vec4(clamp(col / 1.5, 0.0, 1.0), 1.0);",
      "}"
    ].join("\n");

    var bakeEnvFS = [
      "#version 300 es",
      "precision highp float;",
      "in vec2 v_ndc;",
      "out vec4 outColor;",
      "const float PI = 3.14159265359;",
      "void main() {",
      "  vec2 uv = v_ndc * 0.5 + 0.5;",
      "  float az = (uv.x - 0.5) * 2.0 * PI;",
      "  float theta = (uv.y - 0.5) * PI;",
      "  float cosT = cos(theta);",
      "  vec3 d = vec3(cosT * cos(az), sin(theta), cosT * sin(az));",
      "  float el = d.y;",
      "",
      "  vec3 skyCol = mix(vec3(0.015, 0.012, 0.014), vec3(0.048, 0.034, 0.026), smoothstep(-0.1, 0.8, el));",
      "  vec3 velvetBounce = vec3(0.11, 0.010, 0.018) * smoothstep(0.15, -0.85, el);",
      "  vec3 env = mix(velvetBounce, skyCol, smoothstep(-0.18, 0.15, el));",
      "",
      "  float topStrip = pow(max(0.0, dot(d, normalize(vec3(0.28, 0.82, 0.50)))), 18.0);",
      "  env += vec3(1.45, 1.06, 0.56) * topStrip;",
      "",
      "  vec3 cDirs[4];",
      "  cDirs[0] = normalize(vec3( 0.72, 0.42,  0.55));",
      "  cDirs[1] = normalize(vec3(-0.62, 0.36,  0.69));",
      "  cDirs[2] = normalize(vec3(-0.74, 0.44, -0.51));",
      "  cDirs[3] = normalize(vec3( 0.58, 0.34, -0.74));",
      "  float cPow[4];",
      "  cPow[0] = 2.40; cPow[1] = 1.45; cPow[2] = 2.05; cPow[3] = 1.55;",
      "  for (int i = 0; i < 4; i++) {",
      "    float nd = max(0.0, dot(d, cDirs[i]));",
      "    float lobe = pow(nd, 32.0);",
      "    float broad = pow(nd, 5.0) * 0.16;",
      "    env += vec3(1.50, 0.92, 0.38) * (lobe + broad) * cPow[i];",
      "  }",
      "",
      "  float rim1 = pow(max(0.0, dot(d, normalize(vec3(-0.35, 0.54, -0.76)))), 22.0);",
      "  float rim2 = pow(max(0.0, dot(d, normalize(vec3( 0.38, 0.48,  0.79)))), 20.0);",
      "  env += vec3(0.42, 0.54, 0.72) * (rim1 * 0.95 + rim2 * 0.60);",
      "",
      "  float horBand = exp(-pow((el - 0.04) * 6.0, 2.0));",
      "  env += vec3(0.28, 0.16, 0.07) * horBand * (0.55 + 0.45 * cos(az * 2.0 + 0.6));",
      "",
      "  // Linear HDR packed in RGBA8 [0..3.5] so hardware mipmaps filter cleanly with zero extensions",
      "  outColor = vec4(clamp(env / 3.5, 0.0, 1.0), 1.0);",
      "}"
    ].join("\n");

    // ------------------------------------------------------------------
    // 4. Runtime Shaders: Ultra-Light Background (Early-Z) + Fast PBR Mesh
    // ------------------------------------------------------------------
    var bgFS = [
      "#version 300 es",
      "precision mediump float;",
      "in vec2 v_ndc;",
      "uniform sampler2D u_bgTex;",
      "uniform vec3 u_camRight;",
      "uniform vec3 u_camUp;",
      "uniform vec3 u_camFwd;",
      "uniform float u_tanHalfFov;",
      "uniform float u_aspect;",
      "uniform float u_flicker;",
      "out vec4 outColor;",
      "const float INV_2PI = 0.15915494;",
      "const float INV_PI  = 0.31830989;",
      "void main() {",
      "  vec3 dir = normalize(",
      "    u_camFwd +",
      "    u_camRight * (v_ndc.x * u_aspect * u_tanHalfFov) +",
      "    u_camUp * (v_ndc.y * u_tanHalfFov)",
      "  );",
      "  vec2 uv = vec2(atan(dir.z, dir.x) * INV_2PI + 0.5, asin(clamp(dir.y, -1.0, 1.0)) * INV_PI + 0.5);",
      "  vec3 col = textureLod(u_bgTex, uv, 0.0).rgb * 1.5 * u_flicker;",
      "  float r2 = dot(v_ndc, v_ndc);",
      "  float screenGlow = exp(-r2 * 1.85);",
      "  col += vec3(0.022, 0.010, 0.0038) * screenGlow * u_flicker;",
      "  col *= clamp(1.0 - 0.48 * r2, 0.28, 1.0);",
      "  col *= 1.15;",
      "  col = clamp((col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14), 0.0, 1.0);",
      "  outColor = vec4(pow(col, vec3(0.454545)), 1.0);",
      "}"
    ].join("\n");

    var meshVS = [
      "#version 300 es",
      "layout(location = 0) in vec3 a_pos;",
      "layout(location = 1) in vec3 a_norm;",
      "layout(location = 2) in vec2 a_uv;",
      "layout(location = 3) in float a_mat;",
      "uniform mat4 u_viewProj;",
      "out vec3 v_pos;",
      "out vec3 v_norm;",
      "out vec2 v_uv;",
      "out float v_mat;",
      "void main() {",
      "  v_pos = a_pos;",
      "  v_norm = a_norm;",
      "  v_uv = a_uv;",
      "  v_mat = a_mat;",
      "  gl_Position = u_viewProj * vec4(a_pos, 1.0);",
      "}"
    ].join("\n");

    var meshFS = [
      "#version 300 es",
      "precision highp float;",
      "in vec3 v_pos;",
      "in vec3 v_norm;",
      "in vec2 v_uv;",
      "in float v_mat;",
      "uniform sampler2D u_envTex;",
      "uniform vec3 u_camPos;",
      "uniform float u_flicker;",
      "out vec4 outColor;",
      "",
      "const float PI = 3.14159265359;",
      "const float INV_2PI = 0.15915494;",
      "const float INV_PI  = 0.31830989;",
      "",
      "float pow5(float x) { float x2 = x * x; return x2 * x2 * x; }",
      "",
      "vec3 sampleEnv(vec3 d, float lod) {",
      "  vec2 uv = vec2(atan(d.z, d.x) * INV_2PI + 0.5, asin(clamp(d.y, -1.0, 1.0)) * INV_PI + 0.5);",
      "  return textureLod(u_envTex, uv, lod).rgb * 3.5 * u_flicker;",
      "}",
      "",
      "vec3 evalLight(vec3 N, vec3 V, vec3 L, vec3 rad, vec3 albedo, float met, float rough, vec3 F0, float NdotV) {",
      "  float NdotL = max(dot(N, L), 0.0);",
      "  if (NdotL <= 0.0) return vec3(0.0);",
      "  vec3 H = normalize(V + L);",
      "  float NdotH = max(dot(N, H), 0.0);",
      "  float HdotV = max(dot(H, V), 0.0);",
      "  float a = rough * rough;",
      "  float a2 = a * a;",
      "  float d = (NdotH * NdotH) * (a2 - 1.0) + 1.0;",
      "  float D = a2 / max(PI * d * d, 1e-5);",
      "  float r1 = rough + 1.0;",
      "  float k = r1 * r1 * 0.125;",
      "  float G = (NdotV / (NdotV * (1.0 - k) + k)) * (NdotL / (NdotL * (1.0 - k) + k));",
      "  vec3 F = F0 + (1.0 - F0) * pow5(1.0 - HdotV);",
      "  vec3 spec = (D * G * F) / max(4.0 * NdotV * NdotL, 1e-4);",
      "  vec3 kD = (vec3(1.0) - F) * (1.0 - met);",
      "  return (kD * albedo * INV_PI + spec) * rad * NdotL;",
      "}",
      "",
      "float evalKeyShadow(vec3 p) {",
      "  if (p.y < -2.6) return 1.0;",
      "  vec2 qBow = (p.xz - vec2(-4.85, 0.0)) / vec2(3.15, 2.65);",
      "  vec2 qBit = (p.xz - vec2(5.75, -0.45)) / vec2(2.35, 1.55);",
      "  float sx = clamp(p.x, -5.0, 7.2);",
      "  vec2 qSh = vec2((p.x - sx) * 0.55, p.z) / vec2(1.4, 1.15);",
      "  float cAO = max(max(exp(-dot(qBow, qBow) * 2.35), exp(-dot(qBit, qBit) * 2.60)), exp(-dot(qSh, qSh) * 2.15) * 0.72);",
      "  // Directional cast offset for L0 = normalize(14, 19, 16)",
      "  vec2 pC = p.xz + vec2(1.07, 1.22);",
      "  vec2 cBow = (pC - vec2(-4.85, 0.0)) / vec2(3.6, 3.0);",
      "  vec2 cBit = (pC - vec2(5.75, -0.45)) / vec2(2.7, 1.9);",
      "  float csx = clamp(pC.x, -5.0, 7.2);",
      "  float cS = exp(-((pC.y * pC.y) / 2.40 + ((pC.x - csx) * (pC.x - csx)) / 3.61)) * 0.58;",
      "  float castSh = max(max(exp(-dot(cBow, cBow) * 1.65), exp(-dot(cBit, cBit) * 1.85)), cS);",
      "  float dark = clamp(cAO * 0.78 + castSh * 0.36, 0.0, 0.86) * smoothstep(-2.4, -0.1, p.y);",
      "  return 1.0 - dark;",
      "}",
      "",
      "void main() {",
      "  vec3 N = normalize(v_norm);",
      "  vec3 V = normalize(u_camPos - v_pos);",
      "  int matId = int(v_mat + 0.5);",
      "",
      "  const vec3 L0 = vec3( 0.493, 0.669,  0.563);",
      "  const vec3 L1 = vec3(-0.642, 0.522, -0.562);",
      "  vec3 C0 = vec3(2.45, 1.64, 0.85) * u_flicker;",
      "  vec3 C1 = vec3(1.30, 0.82, 0.40);",
      "",
      "  vec3 albedo = vec3(0.5);",
      "  float metallic = 0.0;",
      "  float rough = 0.5;",
      "  float ao = 1.0;",
      "  float keySh = 1.0;",
      "  vec3 sheenTerm = vec3(0.0);",
      "  float specBoost = 1.0;",
      "",
      "  if (matId == 0) {",
      "    float goldMask = smoothstep(0.49, 0.55, v_uv.y);",
      "    float brush = 0.5 + 0.5 * sin(v_pos.x * 32.0 + v_pos.z * 16.0);",
      "    albedo = mix(vec3(0.078, 0.066, 0.062), vec3(0.96, 0.73, 0.30), goldMask);",
      "    metallic = mix(0.91, 0.98, goldMask);",
      "    rough = mix(0.22, 0.15, goldMask) + (brush - 0.5) * 0.03;",
      "    ao = mix(0.70, 1.0, smoothstep(-0.35, 1.15, v_pos.y));",
      "    specBoost = 1.38;",
      "  } else if (matId == 1) {",
      "    float rXZ = length(v_pos.xz);",
      "    float crease = sin(atan(v_pos.z, v_pos.x) * 4.0 + rXZ * 0.14) * 0.042 * smoothstep(2.0, 14.0, rXZ);",
      "    float napA = sin(v_pos.x * 0.52 + sin(v_pos.z * 0.47) * 1.8) * cos(v_pos.z * 0.59 - sin(v_pos.x * 0.41) * 1.6);",
      "    float napB = sin(v_pos.x * 31.0 + v_pos.z * 19.0) * sin(-v_pos.x * 17.0 + v_pos.z * 37.0);",
      "    float pile = napA * 0.020 + napB * 0.008 + crease;",
      "    N = normalize(N + vec3(pile, 0.0, -pile * 0.85));",
      "    float nDotV0 = max(dot(N, V), 0.0);",
      "    float g1 = 1.0 - nDotV0;",
      "    float grazing = g1 * g1 * sqrt(g1);",
      "    float rEdge = smoothstep(5.0, 16.5, rXZ);",
      "    albedo = mix(vec3(0.048, 0.0028, 0.0062), vec3(0.028, 0.0016, 0.0042), rEdge * 0.55) * (0.93 + 0.11 * napA);",
      "    rough = 0.94;",
      "    specBoost = 0.16;",
      "    keySh = evalKeyShadow(v_pos);",
      "    ao = keySh * mix(0.22, 1.0, smoothstep(-6.4, -3.6, v_pos.y));",
      "    float lightWrap = 0.25 + 0.65 * max(dot(N, L0), 0.0) + 0.28 * max(dot(N, L1), 0.0);",
      "    sheenTerm = vec3(0.32, 0.022, 0.044) * grazing * lightWrap * ao;",
      "  } else if (matId == 2) {",
      "    float braid = sin(atan(v_pos.z, v_pos.x) * 110.0 + v_pos.y * 16.0);",
      "    if (v_pos.y > -5.6) N = normalize(N + vec3(0.0, braid * 0.09, 0.0));",
      "    albedo = vec3(0.86, 0.62, 0.24);",
      "    metallic = 0.95;",
      "    rough = 0.22 + braid * 0.025;",
      "    ao = mix(0.45, 1.0, smoothstep(-7.0, -4.4, v_pos.y));",
      "    specBoost = 1.18;",
      "  } else {",
      "    float vein = smoothstep(0.65, 0.95, abs(sin(v_pos.x * 0.35 + sin(v_pos.z * 0.28) * 2.2)));",
      "    albedo = mix(vec3(0.011, 0.010, 0.012), vec3(0.026, 0.021, 0.019), vein * 0.55);",
      "    metallic = 0.06;",
      "    rough = 0.34 + vein * 0.10;",
      "    float cSh = smoothstep(13.5, 20.5, length(v_pos.xz));",
      "    float topAO = (v_pos.y > -6.6) ? mix(0.18, 0.78, cSh) : smoothstep(-6.0, -8.5, v_pos.y);",
      "    ao = topAO * mix(0.35, 1.0, smoothstep(-26.0, -10.5, v_pos.y));",
      "    specBoost = 0.42;",
      "  }",
      "",
      "  vec3 F0 = mix(vec3(0.04), albedo, metallic);",
      "  float NdotV = max(dot(N, V), 0.001);",
      "",
      "  vec3 Lo = evalLight(N, V, L0, C0, albedo, metallic, rough, F0, NdotV) * keySh",
      "          + evalLight(N, V, L1, C1, albedo, metallic, rough, F0, NdotV);",
      "",
      "  // Hardware-filtered pre-baked 360° Sanctuary HDR IBL",
      "  vec3 R = reflect(-V, N);",
      "  vec3 envSpec = sampleEnv(R, rough * 5.2);",
      "  vec3 envDiff = sampleEnv(N, 6.2);",
      "  vec3 F_ibl = F0 + (max(vec3(1.0 - rough), F0) - F0) * pow5(1.0 - NdotV);",
      "  vec3 kD_ibl = (vec3(1.0) - F_ibl) * (1.0 - metallic);",
      "  vec3 ibl = (kD_ibl * albedo * envDiff * 0.48 + F_ibl * envSpec * mix(1.0, 0.16, rough * rough) * specBoost) * ao;",
      "",
      "  vec3 color = ibl + Lo * mix(0.35, 1.0, ao) + sheenTerm;",
      "  if (matId == 0) {",
      "    float g = 1.0 - NdotV;",
      "    color += vec3(0.38, 0.27, 0.13) * (g * g * g) * ao;",
      "  }",
      "",
      "  color *= 1.02;",
      "  color = clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0.0, 1.0);",
      "  outColor = vec4(pow(color, vec3(0.454545)), 1.0);",
      "}"
    ].join("\n");

    var bakeBgProg = createProgram(fullTriVS, bakeBgFS);
    var bakeEnvProg = createProgram(fullTriVS, bakeEnvFS);
    var bgProg = createProgram(fullTriVS, bgFS);
    var meshProg = createProgram(meshVS, meshFS);
    if (!bakeBgProg || !bakeEnvProg || !bgProg || !meshProg) return;

    // ------------------------------------------------------------------
    // 5. Bake Both 360° Textures Once into Offscreen FBO (<2 ms total)
    // ------------------------------------------------------------------
    var emptyVao = gl.createVertexArray();
    function bakeEquirect(prog, width, height, mipmapped) {
      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmapped ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);

      var fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.viewport(0, 0, width, height);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.useProgram(prog);
      gl.bindVertexArray(emptyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo);

      if (mipmapped) {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.generateMipmap(gl.TEXTURE_2D);
      }
      gl.deleteProgram(prog);
      return tex;
    }

    var bgTex = bakeEquirect(bakeBgProg, 512, 256, false);
    var envTex = bakeEquirect(bakeEnvProg, 256, 128, true);

    // ------------------------------------------------------------------
    // 6. Upload 3D Mesh VAO / VBO
    // ------------------------------------------------------------------
    var meshVao = gl.createVertexArray();
    gl.bindVertexArray(meshVao);
    var vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vboData, gl.STATIC_DRAW);

    var fStride = 9 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, fStride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, fStride, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, fStride, 24);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, fStride, 32);
    gl.bindVertexArray(null);

    // Bind static texture unit indices once
    gl.useProgram(bgProg);
    gl.uniform1i(gl.getUniformLocation(bgProg, "u_bgTex"), 0);
    gl.useProgram(meshProg);
    gl.uniform1i(gl.getUniformLocation(meshProg, "u_envTex"), 1);

    var bgLoc = {
      camRight: gl.getUniformLocation(bgProg, "u_camRight"),
      camUp: gl.getUniformLocation(bgProg, "u_camUp"),
      camFwd: gl.getUniformLocation(bgProg, "u_camFwd"),
      tanHalfFov: gl.getUniformLocation(bgProg, "u_tanHalfFov"),
      aspect: gl.getUniformLocation(bgProg, "u_aspect"),
      flicker: gl.getUniformLocation(bgProg, "u_flicker")
    };
    var meshLoc = {
      viewProj: gl.getUniformLocation(meshProg, "u_viewProj"),
      camPos: gl.getUniformLocation(meshProg, "u_camPos"),
      flicker: gl.getUniformLocation(meshProg, "u_flicker")
    };

    // ------------------------------------------------------------------
    // 7. Zero-Allocation Pre-Allocated Math Buffers
    // ------------------------------------------------------------------
    var projMat = new Float32Array(16);
    var viewMat = new Float32Array(16);
    var vpMat = new Float32Array(16);
    var eyeVec = new Float32Array(3);
    var rightVec = new Float32Array(3);
    var upVec = new Float32Array(3);
    var fwdVec = new Float32Array(3);

    function writePerspective(out, fov, aspect, near, far) {
      var f = 1.0 / Math.tan(fov * 0.5);
      var nf = 1.0 / (near - far);
      out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
      out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
      out[8] = 0; out[9] = 0; out[10] = (far + near) * nf; out[11] = -1;
      out[12] = 0; out[13] = 0; out[14] = 2 * far * near * nf; out[15] = 0;
    }

    function writeLookAt(tx, ty, tz) {
      var fx = tx - eyeVec[0], fy = ty - eyeVec[1], fz = tz - eyeVec[2];
      var fl = Math.hypot(fx, fy, fz) || 1.0;
      fx /= fl; fy /= fl; fz /= fl;
      fwdVec[0] = fx; fwdVec[1] = fy; fwdVec[2] = fz;

      var rx = -fz, rz = fx;
      var rl = Math.hypot(rx, rz) || 1.0;
      rx /= rl; rz /= rl;
      rightVec[0] = rx; rightVec[1] = 0.0; rightVec[2] = rz;

      var ux = -rz * fy;
      var uy = rz * fx - rx * fz;
      var uz = rx * fy;
      upVec[0] = ux; upVec[1] = uy; upVec[2] = uz;

      viewMat[0] = rx; viewMat[1] = ux; viewMat[2] = -fx; viewMat[3] = 0;
      viewMat[4] = 0;  viewMat[5] = uy; viewMat[6] = -fy; viewMat[7] = 0;
      viewMat[8] = rz; viewMat[9] = uz; viewMat[10] = -fz; viewMat[11] = 0;
      viewMat[12] = -(rx * eyeVec[0] + rz * eyeVec[2]);
      viewMat[13] = -(ux * eyeVec[0] + uy * eyeVec[1] + uz * eyeVec[2]);
      viewMat[14] =  (fx * eyeVec[0] + fy * eyeVec[1] + fz * eyeVec[2]);
      viewMat[15] = 1;
    }

    function writeMulMat4(out, a, b) {
      for (var c = 0; c < 4; c++) {
        var b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
        out[c * 4 + 0] = a[0] * b0 + a[4] * b1 + a[8]  * b2 + a[12] * b3;
        out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9]  * b2 + a[13] * b3;
        out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
        out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
      }
    }

    // ------------------------------------------------------------------
    // 8. Continuous 360° Orbital Pan + Interactive Drag + Click-to-Unlock
    // ------------------------------------------------------------------
    var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var yaw = 1.02;
    var pitch = 0.40;
    var targetPitch = 0.40;
    var orbitDist = 33.5;
    var targetY = -1.25;
    var fovRad = (33.0 * Math.PI) / 180.0;
    var tanHalfFov = Math.tan(fovRad * 0.5);

    var velYaw = 0.0;
    var dragging = false;
    var manualLock = false;
    var lastUserInteract = -10.0;
    var lastX = 0, lastY = 0, dragDist = 0;
    var autoOrbitSpeed = reduced ? 0.0 : 0.31;

    // Cache plate bounding rect outside the render loop (zero per-frame reflow!)
    var plateRect = plate.getBoundingClientRect();
    var curW = 2, curH = 2, curAspect = 16 / 9;
    var resScale = Math.min(window.devicePixelRatio || 1, 1.5);

    function resizeCanvas() {
      var rect = canvas.getBoundingClientRect();
      plateRect = plate.getBoundingClientRect();
      var w = Math.max(2, Math.round(rect.width * resScale));
      var h = Math.max(2, Math.round(rect.height * resScale));
      if (w !== curW || h !== curH) {
        curW = w;
        curH = h;
        curAspect = w / Math.max(1, h);
        canvas.width = w;
        canvas.height = h;
        writePerspective(projMat, fovRad, curAspect, 1.0, 180.0);
      }
    }
    resizeCanvas();
    if (window.ResizeObserver) {
      new ResizeObserver(resizeCanvas).observe(canvas);
    } else {
      window.addEventListener("resize", resizeCanvas);
    }

    plate.addEventListener("pointerdown", function (e) {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      dragging = true;
      manualLock = false;
      plateRect = plate.getBoundingClientRect();
      lastX = e.clientX;
      lastY = e.clientY;
      dragDist = 0;
      velYaw = 0;
      plate.classList.add("dragging");
      if (plate.setPointerCapture && e.pointerType !== "touch") {
        try { plate.setPointerCapture(e.pointerId); } catch (_) {}
      }
    });

    plate.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var dx = e.clientX - lastX;
      var dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      dragDist += Math.hypot(dx, dy);

      yaw -= dx * 0.0085;
      velYaw = -dx * 0.0085;
      targetPitch = Math.max(0.20, Math.min(1.08, targetPitch + dy * 0.0065));
      lastUserInteract = performance.now() * 0.001;
    });

    function finishPointer(isCancel) {
      if (!dragging) return;
      dragging = false;
      plate.classList.remove("dragging");
      lastUserInteract = performance.now() * 0.001;
      if (!isCancel && dragDist < 6.0) {
        window.dispatchEvent(new CustomEvent("veristrux:open-key-modal"));
      }
    }
    plate.addEventListener("pointerup", function () { finishPointer(false); });
    plate.addEventListener("pointercancel", function () { finishPointer(true); });

    var isVisible = true;
    if (window.IntersectionObserver) {
      new IntersectionObserver(function (entries) {
        isVisible = entries[0] ? entries[0].isIntersecting : true;
      }, { threshold: 0.05 }).observe(plate);
    }

    // ------------------------------------------------------------------
    // 9. Early-Z Two-Pass Render Loop (Zero Allocation, Adaptive Scale)
    // ------------------------------------------------------------------
    var startTs = performance.now() * 0.001;
    var prevTs = startTs;
    var firstRendered = false;
    var slowFrameCount = 0;

    function renderFrame(nowSec, dt) {
      if (!manualLock) {
        if (!dragging) {
          var idleSince = nowSec - lastUserInteract;
          if (idleSince > 2.4 && autoOrbitSpeed > 0) {
            var blend = Math.min(1.0, (idleSince - 2.4) * 0.8);
            yaw += autoOrbitSpeed * dt * blend;
            var autoPitch = 0.40 + 0.042 * Math.sin(yaw);
            targetPitch += (autoPitch - targetPitch) * Math.min(1.0, dt * 1.4);
          }
          yaw += velYaw;
          velYaw *= Math.pow(0.06, dt);
        }
        pitch += (targetPitch - pitch) * Math.min(1.0, dt * 10.0);
      }

      var cosP = Math.cos(pitch);
      var sinP = Math.sin(pitch);
      eyeVec[0] = Math.cos(yaw) * cosP * orbitDist;
      eyeVec[1] = targetY + sinP * orbitDist;
      eyeVec[2] = Math.sin(yaw) * cosP * orbitDist;

      writeLookAt(0.0, targetY, 0.0);
      writeMulMat4(vpMat, projMat, viewMat);

      var t = nowSec - startTs;
      var flk = 1.0 + 0.045 * Math.sin(t * 3.8 + 0.4) + 0.025 * Math.sin(t * 9.1);

      gl.viewport(0, 0, curW, curH);
      gl.depthMask(true);
      gl.clearDepth(1.0);
      gl.clear(gl.DEPTH_BUFFER_BIT);

      // PASS 1: 3D PBR Mesh FIRST (populates depth buffer for hardware Early-Z rejection)
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      gl.frontFace(gl.CCW);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, envTex);
      gl.useProgram(meshProg);
      gl.bindVertexArray(meshVao);
      gl.uniformMatrix4fv(meshLoc.viewProj, false, vpMat);
      gl.uniform3fv(meshLoc.camPos, eyeVec);
      gl.uniform1f(meshLoc.flicker, flk);
      gl.drawArrays(gl.TRIANGLES, 0, vCount);

      // PASS 2: Pre-baked 360° Sanctuary Bokeh SECOND (only shades visible background pixels!)
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, bgTex);
      gl.useProgram(bgProg);
      gl.bindVertexArray(emptyVao);
      gl.uniform3fv(bgLoc.camRight, rightVec);
      gl.uniform3fv(bgLoc.camUp, upVec);
      gl.uniform3fv(bgLoc.camFwd, fwdVec);
      gl.uniform1f(bgLoc.tanHalfFov, tanHalfFov);
      gl.uniform1f(bgLoc.aspect, curAspect);
      gl.uniform1f(bgLoc.flicker, flk);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.depthMask(true);

      if (!firstRendered) {
        firstRendered = true;
        canvas.classList.add("ready");
        plate.classList.add("webgl-live");
      }
    }

    function loop(tsMs) {
      var nowSec = tsMs * 0.001;
      var rawDt = nowSec - prevTs;
      prevTs = nowSec;
      var dt = Math.min(0.05, Math.max(0.001, rawDt));

      // Adaptive resolution governor for busy/integrated GPUs
      if (rawDt > 0.038 && resScale > 0.85) {
        slowFrameCount++;
        if (slowFrameCount > 12) {
          resScale = Math.max(0.8, resScale * 0.8);
          slowFrameCount = 0;
          resizeCanvas();
        }
      } else if (slowFrameCount > 0) {
        slowFrameCount--;
      }

      if (isVisible && !document.hidden) {
        renderFrame(nowSec, dt);
      }
      requestAnimationFrame(loop);
    }

    renderFrame(startTs, 0.016);
    requestAnimationFrame(loop);

    window.__veristruxKeyStage = {
      ready: true,
      triangles: vCount / 3,
      setAngle: function (yawDeg, pitchDeg) {
        manualLock = true;
        yaw = (yawDeg * Math.PI) / 180.0;
        pitch = targetPitch = ((pitchDeg !== undefined ? pitchDeg : 23.0) * Math.PI) / 180.0;
        renderFrame(performance.now() * 0.001, 0.016);
      },
      resumeAuto: function () {
        manualLock = false;
        lastUserInteract = -10.0;
      }
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initSovereignKeyStage);
  } else {
    initSovereignKeyStage();
  }
})();
