/**
 * dsh-plugin2preset — Host 半身。
 *
 * 提供「把插件创造为一个同名模式」的后端：安装插件 → 生成并注册一个包装它的
 * agent preset（模式）→ 插件只在该模式里加载，其它会话零上下文占用。
 *
 * 复用宿主既有的 pluginManager 服务（@deepseek-ai/dsh-plugin-manager，key = 'pluginManager'）：
 *   · installBundle(spec, { enabled:false }) —— 装成依赖、不选入 dsh.profile.bundles；
 *   · installBundle(<preset 目录>, { enabled:true }) —— 注册模式包装 bundle。
 * 这两步都走 pluginManager 自己的 pnpm / 选择 / patch 逻辑，本插件不手写 profile 的
 * package.json 或 cordis.patch.yml。
 *
 * 通道：本插件自己的 Web 路由 /dsh-plugin2preset/api/*（与 dsh-proxy / sessionsM 同一套做法），
 * 只信任本机来源。Client 半身 client.js 通过它触发。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'plugin2preset'

const ROUTE_BASE = '/dsh-plugin2preset'
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** 由包名生成一个安全的 preset id / 目录名。 */
function slugify(input) {
  const base = String(input || '')
    .toLowerCase()
    .replace(/^@[^/]+\//, '') // 去掉 scope
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return (base || 'plugin').slice(0, 40)
}

/** 由包名生成一个人类可读的模式名。 */
function displayName(input) {
  const base = String(input || '')
    .replace(/^@[^/]+\//, '')
    .trim()
  return base || String(input || 'Mode')
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch (error) {
        reject(new Error(`JSON 解析失败：${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

function hostnameOf(headerHost) {
  if (typeof headerHost !== 'string') return ''
  const value = headerHost.trim()
  if (value === '') return ''
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end > 0 ? value.slice(0, end + 1) : value
  }
  return value.split(':')[0]
}

/**
 * dsh-plugin2preset 直接管理 profile 的 cordis.patch.yml：不生成独立 @local 壳 bundle，
 * 而是把 preset 声明写进 patch 的一段「托管区」（REA 模式那种做法）。
 * 用户视角：插件列表里不会多出一个 @local 条目，模式仍能在预设选择器里选到。
 *
 * 托管状态存 <profileDir>/storages/dsh-plugin2preset/modes.json，
 * 每次变更据此重建 patch 里的托管区（两行锚点注释之间）。
 *
 * 兼容旧版 marker（dsh-plugin-as-mode managed region）：读取旧托管区时会一并识别并迁移，
 * 新写入一律使用新 marker（dsh-plugin2preset managed region）。
 */
const PATCH_BEGIN = '# >>> dsh-plugin2preset managed region (auto-generated, do not edit by hand) >>>'
const PATCH_END = '# <<< dsh-plugin2preset managed region <<<'
const LEGACY_PATCH_BEGIN = '# >>> dsh-plugin-as-mode managed region (auto-generated, do not edit by hand) >>>'
const LEGACY_PATCH_END = '# <<< dsh-plugin-as-mode managed region <<<'

function modesMetaPath(profileDir) {
  return join(profileDir, 'storages', 'dsh-plugin2preset', 'modes.json')
}
function readModesMeta(profileDir) {
  try {
    const v = JSON.parse(readFileSync(modesMetaPath(profileDir), 'utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch { return {} }
}
function writeModesMeta(profileDir, meta) {
  mkdirSync(join(profileDir, 'storages', 'dsh-plugin2preset'), { recursive: true })
  writeFileSync(modesMetaPath(profileDir), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
}

function builtinPresetYaml(id, m) {
  const title = m.name || m.pkgName
  const description = m.description || `「${title}」模式：${m.pkgName} 的工具只在本模式下加载，其它会话不占用上下文。`
  return (
    `- insert:\n` +
    `    - id: preset-${id}\n` +
    `      name: '@deepseek-ai/dsh-agent-preset'\n` +
    `      config:\n` +
    `        id: ${JSON.stringify(id)}\n` +
    `        name: ${JSON.stringify(title)}\n` +
    `        description: ${JSON.stringify(description)}\n` +
    `        order: ${Number(m.order ?? 20)}\n` +
    `        plugins:\n` +
    `          - id: ${JSON.stringify(id)}\n` +
    `            name: ${JSON.stringify(m.pkgName)}\n`
  )
}

/** 依 modes.json 重写 cordis.patch.yml 的托管区；无模式时移除托管区。 */
function stripRegion(text, begin, end) {
  const beginIdx = text.indexOf(begin)
  if (beginIdx < 0) return text
  const endIdx = text.indexOf(end, beginIdx)
  if (endIdx >= 0) return text.slice(0, beginIdx) + text.slice(endIdx + end.length)
  return text.slice(0, beginIdx)
}

function syncPatch(profileDir, meta) {
  const patchPath = join(profileDir, 'cordis.patch.yml')
  let text = ''
  try { text = readFileSync(patchPath, 'utf8') } catch { text = '' }
  // 去掉已有托管区（新标记 + 旧版标记，确保从旧版迁移后不残留）
  text = stripRegion(text, PATCH_BEGIN, PATCH_END)
  text = stripRegion(text, LEGACY_PATCH_BEGIN, LEGACY_PATCH_END)
  text = text.replace(/\n+$/, '\n')
  const ids = Object.keys(meta)
  if (ids.length > 0) {
    let region = `\n${PATCH_BEGIN}\n`
    for (const id of ids) region += builtinPresetYaml(id, meta[id])
    region += `${PATCH_END}\n`
    text = text + region
  }
  writeFileSync(patchPath, text, 'utf8')
}

export function apply(ctx) {
  /** 取服务，缺失返回 undefined（冷启动时可能还没就绪）。 */
  const pm = () => ctx.get('pluginManager')
  const profileCtx = () => ctx.get('profileContext')

  async function api(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const base = `${ROUTE_BASE}/api`

    // 诊断：clientModules 是否认得本包的 client 半身（只在排查时用）。不依赖 manager/profile。
    if (url.pathname === `${base}/_diag` && req.method === 'GET') {
      const cm = ctx.get('clientModules')
      const out = { hasClientModules: !!cm, pkg: 'dsh-plugin2preset' }
      try {
        if (cm && typeof cm.clientPath === 'function') out.clientPath = cm.clientPath('dsh-plugin2preset') ?? null
        if (cm && typeof cm.graph === 'function') {
          const g = cm.graph()
          out.graphIds = (g && (g.entries || g.rows || g.plugins) || []).map?.(x => x.id || x.packageName) ?? null
          out.graphHasMine = JSON.stringify(g).includes('plugin2preset')
        }
      } catch (e) { out.error = String(e && e.message || e) }
      // 附带 authenticated URL（排查 GUI 时用，仅本机可得）
      try {
        const conn = ctx.get('connection')
        const webApp = ctx.get('webApp')
        if (conn && webApp && typeof conn.authenticatedUrl === 'function') {
          out.authUrl = conn.authenticatedUrl(webApp.getAdvertisedUrl())
        }
      } catch (e) { out.authUrlError = String(e && e.message || e) }
      return sendJson(res, 200, { ok: true, value: out })
    }

    const manager = pm()
    const profile = profileCtx()
    if (!manager || !profile) {
      return sendJson(res, 503, { ok: false, error: { code: 'not-ready', message: '插件管理器尚未就绪，请稍后重试。' } })
    }

    // 列出已装 bundle，供 Client 端详情入口判断。
    if (url.pathname === `${base}/bundles` && req.method === 'GET') {
      const bundles = await manager.listBundles()
      return sendJson(res, 200, {
        ok: true,
        value: bundles.map((b) => ({ name: b.name, version: b.version ?? null, installed: b.installed, enabled: b.enabled, availability: b.availability })),
      })
    }

    // 直接安装（不转模式）：enabled 默认 true，装完即选入根 bundles。
    if (url.pathname === `${base}/install` && req.method === 'POST') {
      const body = await readJson(req)
      const spec = String(body.spec ?? '').trim()
      if (spec === '') return sendJson(res, 400, { ok: false, error: { code: 'empty-spec', message: '请填写插件包名 / GitHub 地址 / 本地路径。' } })
      const enabled = body.enabled !== false
      const result = await manager.installBundle(spec, {
        enabled,
        ...(body.registry ? { registry: String(body.registry) } : {}),
      })
      return sendJson(res, 200, { ok: true, value: summarize(result, false) })
    }

    // 创造为同名模式：安装(enabled:false) → 生成 preset 包装 bundle → 注册。
    if (url.pathname === `${base}/convert` && req.method === 'POST') {
      const body = await readJson(req)
      const spec = String(body.spec ?? '').trim()
      if (spec === '') return sendJson(res, 400, { ok: false, error: { code: 'empty-spec', message: '请填写插件包名 / GitHub 地址 / 本地路径。' } })
      const modeName = body.name ? String(body.name).trim() : undefined
      const install = await manager.installBundle(spec, {
        enabled: false,
        ...(body.registry ? { registry: String(body.registry) } : {}),
      })
      if (install.application === 'failed' || install.application === 'cancelled') {
        return sendJson(res, 200, { ok: false, error: { code: String(install.error?.code ?? 'install-failed'), message: '安装失败，未创建模式。' }, value: summarize(install, true) })
      }
      const pkgName = install.bundle
      if (!pkgName) {
        return sendJson(res, 200, { ok: false, error: { code: 'no-bundle', message: '这个包没有声明 dsh.bundle，无法包成模式（它可能只是依赖库）。' }, value: summarize(install, true) })
      }
      return await registerMode(res, manager, profile, pkgName, { name: modeName, description: body.description })
    }

    // 从已装插件转模式：把当前已在根 bundles 里的插件抽出为模式。
    if (url.pathname === `${base}/from-installed` && req.method === 'POST') {
      const body = await readJson(req)
      const pkgName = String(body.packageName ?? '').trim()
      if (pkgName === '') return sendJson(res, 400, { ok: false, error: { code: 'empty-name', message: '缺少插件包名。' } })
      const modeName = body.name ? String(body.name).trim() : undefined
      // 先从根 bundles 选择中移除（保留依赖），使插件不再全局加载。
      try {
        await manager.setBundleEnabled(pkgName, false)
      } catch (error) {
        /* 未安装或不可选，忽略；随后仍尝试建模式 */
        ctx.logger?.warn?.(`plugin2preset: 取消所选 bundle 失败 ${pkgName}: ${error instanceof Error ? error.message : String(error)}`)
      }
      return await registerMode(res, manager, profile, pkgName, { name: modeName, description: body.description })
    }

    // 重命名已存在的模式（内置 Agent 预设页只能选默认，不能改名；这里支持改名）。
    if (url.pathname === `${base}/rename` && req.method === 'POST') {
      const body = await readJson(req)
      const pkgName = String(body.packageName ?? '').trim()
      const newName = String(body.name ?? '').trim()
      if (pkgName === '') return sendJson(res, 400, { ok: false, error: { code: 'empty-name', message: '缺少插件包名。' } })
      if (newName === '') return sendJson(res, 400, { ok: false, error: { code: 'empty-title', message: '请填写新的模式名称。' } })
      const id = body.id ? String(body.id) : `mode-${slugify(pkgName)}`
      try {
        const meta = readModesMeta(profile.dir)
        meta[id] = { pkgName, name: newName, description: body.description, order: meta[id] ? meta[id].order : undefined }
        writeModesMeta(profile.dir, meta)
        syncPatch(profile.dir, meta)
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: { code: 'write-failed', message: `改名写入失败：${error instanceof Error ? error.message : String(error)}` } })
      }
      return sendJson(res, 200, {
        ok: true,
        value: { application: 'restart-required', packageName: pkgName, presetId: id, modeName: newName, needsRestart: true, guidance: `模式已改名为「${newName}」。重启宿主后生效。` },
      })
    }

    // 删除一个模式声明。
    if (url.pathname === `${base}/remove-mode` && req.method === 'POST') {
      const body = await readJson(req)
      const id = String(body.id ?? '').trim()
      if (id === '') return sendJson(res, 400, { ok: false, error: { code: 'empty-id', message: '缺少模式 id。' } })
      let removed
      try { removed = removeMode(profile, id) } catch (error) {
        return sendJson(res, 500, { ok: false, error: { code: 'write-failed', message: `删除失败：${String(error && error.message || error)}` } })
      }
      return sendJson(res, 200, { ok: removed, value: { removed, id, needsRestart: removed } })
    }

    return sendJson(res, 404, { ok: false, error: { code: 'not-found', message: '没有这个接口。' } })
  }

  async function registerMode(res, manager, profile, pkgName, opts) {
    const id = opts.id || `mode-${slugify(pkgName)}`
    const title = opts.name || displayName(pkgName)
    try {
      const meta = readModesMeta(profile.dir)
      meta[id] = { pkgName, name: title, description: opts.description, order: opts.order }
      writeModesMeta(profile.dir, meta)
      syncPatch(profile.dir, meta)
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: { code: 'write-failed', message: `写入模式声明失败：${error instanceof Error ? error.message : String(error)}` } })
    }
    return sendJson(res, 200, {
      ok: true,
      value: {
        application: 'restart-required',
        changed: true,
        packageName: pkgName,
        presetId: id,
        modeName: title,
        needsRestart: true,
        guidance: `已创建模式「${title}」并写入 profile 配置。重启宿主后，新建会话时在模式选择器里选它（已有会话不换模式）。`,
      },
    })
  }

  /** 删除一个模式声明（从 modes.json + patch 托管区移除）。 */
  function removeMode(profile, id) {
    const meta = readModesMeta(profile.dir)
    if (!(id in meta)) return false
    delete meta[id]
    writeModesMeta(profile.dir, meta)
    syncPatch(profile.dir, meta)
    return true
  }

  function summarize(result, asMode) {
    return {
      application: result.application,
      changed: result.changed === true,
      bundle: result.bundle ?? null,
      version: result.version ?? null,
      asMode: asMode === true,
      needsRestart: result.application === 'restart-required',
      error: result.error ? { code: result.error.code ?? null, message: result.error.message ?? String(result.error.code ?? '') } : null,
    }
  }

  const handler = async (req, res) => {
    try {
      const hostname = hostnameOf(req.headers.host)
      if (!LOOPBACK.has(hostname)) {
        return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: `不被信任的 Host：${hostname || '(空)'}` } })
      }
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : ''
      if (origin !== '') {
        let originHost = ''
        try { originHost = new URL(origin).host } catch {
          return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: '请求来源不被信任。' } })
        }
        if (originHost !== req.headers.host) {
          return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: '请求来源不被信任。' } })
        }
      }
      await api(req, res)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.error?.(error instanceof Error ? error : new Error(message))
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: { code: 'internal', message: `操作失败：${message}` } })
      }
    }
  }

  // Web 路由：冷启动时 webServer 可能尚未就绪，轮询直到挂上（同 dsh-proxy）。
  ctx.effect(() => {
    let disposeRoute = null
    let elapsed = 0
    const attach = () => {
      const web = ctx.get('webServer')
      if (!web || disposeRoute) return false
      try {
        disposeRoute = web.register({ kind: 'prefix', path: `${ROUTE_BASE}/api`, handler })
        return true
      } catch (error) {
        ctx.logger?.warn?.(`plugin2preset: 路由注册失败，稍后重试：${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    }
    if (attach()) return () => disposeRoute?.()
    const timer = setInterval(() => {
      elapsed += 250
      if (attach() || elapsed >= 60_000) {
        clearInterval(timer)
        if (elapsed >= 60_000 && !disposeRoute) {
          ctx.logger?.error?.(new Error('plugin2preset: webServer 60 秒内未提供，接口未挂载'))
        }
      }
    }, 250)
    timer.unref?.()
    return () => {
      clearInterval(timer)
      try { disposeRoute?.() } catch { /* 忽略 */ }
    }
  }, 'plugin2preset: api')
}
