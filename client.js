/**
 * dsh-plugin2preset — Web Client 半身。
 *
 * 两个入口：
 *   1. plugins.add.actions —— 插件页 Add plugin 菜单末尾的「创造为同名模式…」，
 *      打开弹窗输入包名 / GitHub / 本地路径，二选一「直接安装 / 创造为同名模式」。
 *   2. plugins.detail.actions —— 已装插件详情页头部的「转为同名模式」，把该插件抽成模式。
 *
 * 前后端通道：本插件自己的 Host 路由 /dsh-plugin2preset/api（见 index.js）。
 * 弹窗、选择、进度都在本文件用一个轻量 portal modal 实现，不依赖宿主内部样式/组件。
 *
 * 三条纪律（同 dsh-proxy）：
 *   1. 只读 inject 里声明的服务；可选服务用 ctx.get。
 *   2. apply 里每个注册各自 try/catch，最坏丢这一行入口，绝不让页面起不来。
 *   3. 整文件一个 IIFE：页面每次重建会重新求值，顶层 let/const 会撞 already declared。
 */
;(function () {
  var PREFIX = '/dsh-plugin2preset/api'
  /** locale namespace（本插件自己的字典命名空间，可任意）。 */
  var NS = 'dsh-plugin2preset'
  /** ModuleLoader 的模块 id —— 必须等于包名（带 scope），否则浏览器模块表对不上、client 半身不注册。 */
  var MODULE_ID = 'dsh-plugin2preset'

  window.__ModuleLoader__.load({
    id: MODULE_ID,
    factory: function (require) {
      var React = require('react')
      var h = React.createElement

      var dictionaries = {
        zh: {
          'add.row.title': '创造为同名模式…',
          'add.row.desc': '装成插件，并包成一个只在该模式里加载的 preset，其它会话零占用',
          'detail.action': '转为同名模式',
          'dialog.title': '创造为同名模式',
          'dialog.intro': '填入插件包名、GitHub 仓库地址或本地目录路径。选择「创造为同名模式」后，插件工具只在这个模式里加载，不占用其它会话的上下文。',
          'dialog.nameLabel': '模式名称（可选）',
          'dialog.namePh': '留空则按插件名命名',
          'dialog.specLabel': '插件包名 / GitHub 地址 / 本地路径',
          'dialog.specPh': '例如：dsh-drawai  或  github:owner/repo  或  D:\\path\\to\\plugin',
          'dialog.cancel': '取消',
          'dialog.installPlain': '直接安装',
          'dialog.createMode': '创造为同名模式',
          'dialog.installing': '处理中…',
          'dialog.donePlain': '已安装。',
          'dialog.doneMode': '已创建模式：',
          'dialog.doneModeTail': '。新建会话时在模式选择器里选它（已有会话不换模式）。',
          'dialog.restart': '（需重启宿主后生效）',
          'dialog.errEmpty': '请填写插件包名 / 地址 / 路径。',
          'dialog.hostMissing': 'Host 接口未就绪，请稍后重试。',
          'detail.confirmTitle': '把该插件转为同名模式',
          'detail.confirmBody': '会创建一个名为「{0}」的模式，并把该插件从全局停用、收进这个模式——之后它只在该模式下加载，其它会话零占用。可在下方改模式名。',
        },
        en: {
          'add.row.title': 'Create as a same-named mode…',
          'add.row.desc': 'Install it and wrap it in a preset that loads only in that mode — no cost to other sessions',
          'detail.action': 'Convert to mode',
          'dialog.title': 'Create as a same-named mode',
          'dialog.intro': 'Enter a package name, GitHub URL, or local directory. “Create as mode” installs it and wraps it in a dedicated preset, so its tools load only inside that mode and never occupy other sessions’ context.',
          'dialog.nameLabel': 'Mode name (optional)',
          'dialog.namePh': 'Defaults to the plugin name',
          'dialog.specLabel': 'Package name / GitHub URL / local path',
          'dialog.specPh': 'e.g. dsh-drawai  or  github:owner/repo  or  D:\\path\\to\\plugin',
          'dialog.cancel': 'Cancel',
          'dialog.installPlain': 'Install directly',
          'dialog.createMode': 'Create as mode',
          'dialog.installing': 'Working…',
          'dialog.donePlain': 'Installed.',
          'dialog.doneMode': 'Created mode: ',
          'dialog.doneModeTail': '. Pick it in the mode selector when you start a new session (existing sessions keep their mode).',
          'dialog.restart': ' (restart the host to apply)',
          'dialog.errEmpty': 'Enter a package name, URL, or path.',
          'dialog.hostMissing': 'Host endpoint not ready — try again shortly.',
          'detail.confirmTitle': 'Convert this plugin to a same-named mode',
          'detail.confirmBody': 'This wraps the plugin in a mode named “{0}” and removes it from the root bundles — it then loads only inside that mode, costing other sessions nothing.',
        },
      }

      // 主题变量；不 import 任何 Harness 内部样式
      var C_TEXT = 'var(--dsw-alias-label-primary, #1f2328)'
      var C_MUTED = 'var(--dsw-alias-label-secondary, #5c6570)'
      var C_BORDER = 'var(--dsw-alias-border-l1, rgba(127,127,127,0.28))'
      var C_FIELD = 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10))'
      var C_ACCENT = 'var(--dsw-alias-brand-primary, #4f6ef7)'
      var C_BAD = '#dc2626'
      var C_OK = '#16a34a'

      function requestJson(path, options) {
        var opts = Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options || {})
        return fetch(path, opts).then(function (res) {
          return res.text().then(function (text) {
            if (res.status === 404) throw new Error('Host 接口未就绪(404)')
            if (!res.ok) throw new Error('HTTP ' + res.status + (text ? ' · ' + text.slice(0, 120) : ''))
            if (!text || text.trim() === '') throw new Error('接口返回空内容(HTTP ' + res.status + ')')
            try { return JSON.parse(text) } catch (e) { throw new Error('接口返回的不是 JSON：' + text.slice(0, 120)) }
          })
        })
      }

      var OVERLAY = {
        position: 'fixed', inset: 0, zIndex: 2147483000, background: 'rgba(0,0,0,0.42)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px',
      }
      var CARD = {
        width: 'min(520px, 100%)', maxHeight: '86vh', overflow: 'auto',
        background: 'var(--dsw-alias-bg-overlay, #fff)', color: C_TEXT,
        border: '1px solid ' + C_BORDER, borderRadius: '12px', padding: '18px 18px 14px',
        boxShadow: '0 18px 60px rgba(0,0,0,0.28)', fontFamily: 'inherit',
      }
      var TITLE = { fontSize: '15px', fontWeight: 600, lineHeight: '22px', margin: '0 0 6px' }
      var INTRO = { fontSize: '12px', color: C_MUTED, lineHeight: '18px', margin: '0 0 14px' }
      var LABEL = { fontSize: '12px', color: C_MUTED, margin: '10px 0 4px', display: 'block' }
      var INPUT = {
        width: '100%', boxSizing: 'border-box', padding: '7px 9px', fontSize: '13px', fontFamily: 'inherit',
        color: C_TEXT, background: C_FIELD, border: '1px solid ' + C_BORDER, borderRadius: '8px', outline: 'none',
      }
      var FOOT = { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }
      function btn(kind) {
        if (kind === 'primary') return { padding: '6px 14px', fontSize: '13px', fontFamily: 'inherit', color: 'var(--dsw-alias-bg-overlay, #fff)', background: C_TEXT, border: '1px solid ' + C_TEXT, borderRadius: '8px', cursor: 'pointer' }
        return { padding: '6px 14px', fontSize: '13px', fontFamily: 'inherit', color: C_TEXT, background: 'transparent', border: '1px solid ' + C_BORDER, borderRadius: '8px', cursor: 'pointer' }
      }
      var NOTE = { fontSize: '12px', lineHeight: '17px', marginTop: '10px' }

      /** 轻量模态：不依赖 react-dom（createPortal 在 react-dom，不在 react），
       *  用 position:fixed + 高 z-index 直接内联渲染即可覆盖全屏。 */
      function PortalModal(props) {
        return h('div', {
          style: OVERLAY,
          onMouseDown: function (e) { if (e.target === e.currentTarget && props.onClose) props.onClose() },
        }, h('div', { style: CARD, role: 'dialog', 'aria-modal': 'true', 'aria-label': props.title }, props.children))
      }

      // 「创造为同名模式」主弹窗（installed 模式用于已装插件转模式/改名）
      function CreateModeDialog(props) {
        var t = props.t
        var installedPkg = props.installedPkg || null
        var isInstalled = !!installedPkg
        var stateP = React.useState({ spec: props.initialSpec || (installedPkg || ''), name: (isInstalled ? (props.initialName || installedPkg) : ''), busy: false, error: null, result: null })
        var st = stateP[0], setSt = stateP[1]
        var patch = function (p) { setSt(function (prev) { return Object.assign({}, prev, p) }) }

        var submit = function (asMode) {
          var spec = isInstalled ? installedPkg : st.spec.trim()
          if (!isInstalled && spec === '') { patch({ error: t('dialog.errEmpty') }); return }
          var path, payload
          if (isInstalled) { path = '/from-installed'; payload = { packageName: installedPkg, name: st.name.trim() || undefined } }
          else if (asMode) { path = '/convert'; payload = { spec: spec, name: st.name.trim() || undefined, enabled: true } }
          else { path = '/install'; payload = { spec: spec, name: st.name.trim() || undefined, enabled: true } }
          patch({ busy: true, error: null, result: null })
          requestJson(PREFIX + path, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }).then(function (body) {
            if (!body) throw new Error('空响应')
            if (body.ok === false) {
              var msg = (body.error && body.error.message) || '操作失败'
              patch({ busy: false, error: msg, result: body.value || null })
              return
            }
            patch({ busy: false, result: body.value, error: null, done: true, asMode: isInstalled ? true : asMode })
            if (props.onDone) props.onDone(body.value, asMode)
          }).catch(function (e) {
            patch({ busy: false, error: String((e && e.message) || e) })
          })
        }

        var dlgTitle = isInstalled ? t('detail.confirmTitle') : t('dialog.title')
        var body
        if (st.done) {
          var v = st.result || {}
          if (st.asMode) {
            body = h('div', { style: NOTE }, (v.guidance
              ? h('span', { key: 'g', style: { color: C_OK } }, v.guidance + ((v.needsRestart) ? t('dialog.restart') : ''))
              : h('span', { key: 'd', style: { color: C_OK } }, t('dialog.doneMode') + (v.modeName || v.presetId || '') + t('dialog.doneModeTail') + (v.needsRestart ? t('dialog.restart') : ''))))
          } else {
            body = h('div', { style: NOTE }, h('span', { style: { color: C_OK } }, t('dialog.donePlain') + ((v && v.bundle) ? ' · ' + v.bundle : '') + ((v && v.needsRestart) ? t('dialog.restart') : '')))
          }
          return h(PortalModal, { title: dlgTitle, onClose: props.onClose },
            h('h3', { style: TITLE }, dlgTitle),
            body,
            h('div', { style: FOOT }, h('button', { type: 'button', style: btn('primary'), onClick: props.onClose }, t('dialog.cancel'))),
          )
        }

        var children = [
          h('h3', { key: 't', style: TITLE }, dlgTitle),
          h('p', { key: 'i', style: INTRO }, isInstalled ? t('detail.confirmBody').replace('{0}', installedPkg) : t('dialog.intro')),
          h('label', { key: 'nl', style: LABEL }, t('dialog.nameLabel')),
          h('input', {
            key: 'ni', style: INPUT, type: 'text', value: st.name, placeholder: isInstalled ? installedPkg : t('dialog.namePh'),
            onChange: function (e) { patch({ name: e.target.value }) },
            onKeyDown: function (e) { if (e.key === 'Enter' && !st.busy) submit(true) },
          }),
        ]
        if (!isInstalled) {
          children.push(h('label', { key: 'sl', style: LABEL }, t('dialog.specLabel')))
          children.push(h('input', {
            key: 'si', style: INPUT, type: 'text', value: st.spec, placeholder: t('dialog.specPh'), autoFocus: true,
            onChange: function (e) { patch({ spec: e.target.value }) },
            onKeyDown: function (e) { if (e.key === 'Enter' && !st.busy) submit(true) },
          }))
        }
        children.push(st.error ? h('div', { key: 'e', style: Object.assign({}, NOTE, { color: C_BAD }) }, st.error) : null)
        var footBtns = [h('button', { key: 'c', type: 'button', style: btn(), disabled: st.busy, onClick: props.onClose }, t('dialog.cancel'))]
        if (!isInstalled) footBtns.push(h('button', { key: 'p', type: 'button', style: btn(), disabled: st.busy, onClick: function () { submit(false) } }, st.busy ? t('dialog.installing') : t('dialog.installPlain')))
        footBtns.push(h('button', { key: 'm', type: 'button', style: btn('primary'), disabled: st.busy, onClick: function () { submit(true) } }, st.busy ? t('dialog.installing') : t('dialog.createMode')))
        children.push(h('div', { key: 'f', style: FOOT }, footBtns))

        return h(PortalModal, { title: dlgTitle, onClose: st.busy ? null : props.onClose }, children)
      }

      // Add plugin 菜单里的一行：点击打开弹窗
      function AddActionRow(props) {
        var t = props.t
        var openP = React.useState(false)
        var open = openP[0], setOpen = openP[1]
        // 用行内样式模拟 MenuItemButton 的可点区域；点击前先关闭外层菜单
        return h(React.Fragment, null,
          h('button', {
            type: 'button', role: 'menuitem',
            style: {
              display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px',
              background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit', color: C_TEXT,
            },
            onClick: function () { if (props.onDismiss) props.onDismiss(); setOpen(true) },
            onMouseEnter: function (e) { e.currentTarget.style.background = C_FIELD },
            onMouseLeave: function (e) { e.currentTarget.style.background = 'transparent' },
          }, h('div', { style: { fontSize: '13px', lineHeight: '18px' } }, t('add.row.title')),
             h('div', { style: { fontSize: '11px', color: C_MUTED, lineHeight: '15px', marginTop: '2px', maxWidth: '260px' } }, t('add.row.desc'))),
          open ? h(CreateModeDialog, { t: t, onClose: function () { setOpen(false) } }) : null,
        )
      }

      // 详情页头部按钮：把当前插件转成模式。用本地 state 打开 React 弹窗（与 add 入口同一组件）。
      function DetailAction(props) {
        var t = props.t
        var subject = (props && props.subject) || {}
        var pkg = subject.pkg || null
        var name = pkg && pkg.name ? pkg.name : null
        var openP = React.useState(false)
        var open = openP[0], setOpen = openP[1]
        if (!name) return null
        if (!(subject.kind === 'bundle' || subject.kind === 'row')) return null
        return h(React.Fragment, null,
          h('button', { type: 'button', style: btn(), onClick: function () { setOpen(true) } }, t('detail.action')),
          open ? h(CreateModeDialog, { t: t, installedPkg: name, initialName: name, onClose: function () { setOpen(false) } }) : null,
        )
      }

      /**
       * 全局助手 window.__dshPlugin2Preset —— 供「核心安装弹窗」和「dshmarket 安装确认弹窗」里
       * 我插入的「创造为同名模式」按钮调用（那些是别的包编译好的 UI，拿不到我的 React 组件）。
       *
       * 用**纯 DOM** 搭一个自包含弹窗（不依赖 react-dom），复用同样的 /api/convert 与 /api/install。
       */
      function tGlobal(k) {
        var d = dictionaries.zh, e = dictionaries.en
        return (d && d[k]) || (e && e[k]) || k
      }
      function installGlobalHelper() {
        if (window.__dshPlugin2Preset) return
        window.__dshPlugin2Preset = {
          label: tGlobal('dialog.createMode'),
          open: function (spec, name) { build({ mode: 'convert', spec: spec, name: name }) },
          openFromInstalled: function (pkgName, title) { build({ mode: 'installed', spec: pkgName, name: title || pkgName }) },
        }
        function build(opts) {
          var installed = opts.mode === 'installed'
            var tg = tGlobal
            var overlay = document.createElement('div')
            overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,0.42);display:flex;align-items:center;justify-content:center;padding:24px;'
            var card = document.createElement('div')
            card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true')
            card.style.cssText = 'width:min(520px,100%);max-height:86vh;overflow:auto;background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#1f2328);border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,0.28));border-radius:12px;padding:18px 18px 14px;box-shadow:0 18px 60px rgba(0,0,0,0.28);font-family:inherit;'
            overlay.appendChild(card)
            var close = function () { try { document.body.removeChild(overlay) } catch (e) {} }
            overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close() })

            var title = document.createElement('h3')
            title.textContent = installed ? tg('detail.confirmTitle') : tg('dialog.title')
            title.style.cssText = 'font-size:15px;font-weight:600;line-height:22px;margin:0 0 6px;'
            card.appendChild(title)
            var intro = document.createElement('p')
            intro.textContent = installed ? tg('detail.confirmBody').replace('{0}', opts.spec) : tg('dialog.intro')
            intro.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary,#5c6570);line-height:18px;margin:0 0 14px;'
            card.appendChild(intro)

            var mkLabel = function (text) { var l = document.createElement('label'); l.textContent = text; l.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary,#5c6570);margin:10px 0 4px;display:block;'; return l }
            var mkInput = function (val, ph) { var i = document.createElement('input'); i.type = 'text'; i.value = val || ''; i.placeholder = ph; i.style.cssText = 'width:100%;box-sizing:border-box;padding:7px 9px;font-size:13px;font-family:inherit;color:var(--dsw-alias-label-primary,#1f2328);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,0.10));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,0.28));border-radius:8px;outline:none;'; return i }

            card.appendChild(mkLabel(tg('dialog.nameLabel')))
            var nameInput = mkInput(opts.name, tg('dialog.namePh'))
            card.appendChild(nameInput)
            var specInput = null
            if (!installed) {
              card.appendChild(mkLabel(tg('dialog.specLabel')))
              specInput = mkInput(opts.spec, tg('dialog.specPh'))
              card.appendChild(specInput)
            }

            var note = document.createElement('div')
            note.style.cssText = 'font-size:12px;line-height:17px;margin-top:10px;'
            card.appendChild(note)

            var foot = document.createElement('div')
            foot.style.cssText = 'display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:16px;'
            var mkBtn = function (text, primary) { var b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.style.cssText = primary ? 'padding:6px 14px;font-size:13px;font-family:inherit;color:var(--dsw-alias-bg-overlay,#fff);background:var(--dsw-alias-label-primary,#1f2328);border:1px solid var(--dsw-alias-label-primary,#1f2328);border-radius:8px;cursor:pointer;' : 'padding:6px 14px;font-size:13px;font-family:inherit;color:var(--dsw-alias-label-primary,#1f2328);background:transparent;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,0.28));border-radius:8px;cursor:pointer;'; return b }
            var cancelBtn = mkBtn(tg('dialog.cancel'), false)
            var plainBtn = installed ? null : mkBtn(tg('dialog.installPlain'), false)
            var modeBtn = mkBtn(tg('dialog.createMode'), true)
            foot.appendChild(cancelBtn); if (plainBtn) foot.appendChild(plainBtn); foot.appendChild(modeBtn)
            card.appendChild(foot)

            var busy = false
            var setBusy = function (v) { busy = v; modeBtn.disabled = v; cancelBtn.disabled = v; if (plainBtn) plainBtn.disabled = v; modeBtn.textContent = v ? tg('dialog.installing') : tg('dialog.createMode'); if (plainBtn) plainBtn.textContent = v ? tg('dialog.installing') : tg('dialog.installPlain') }
            cancelBtn.onclick = close
            var submit = function (asMode) {
              var s = installed ? opts.spec : (specInput ? specInput.value.trim() : '')
              if (!installed && s === '') { note.style.color = '#dc2626'; note.textContent = tg('dialog.errEmpty'); return }
              setBusy(true); note.style.color = ''; note.textContent = ''
              var path, payload
              if (installed) { path = '/from-installed'; payload = { packageName: opts.spec, name: nameInput.value.trim() || undefined } }
              else { path = asMode ? '/convert' : '/install'; payload = { spec: s, name: nameInput.value.trim() || undefined, enabled: true } }
              requestJson(PREFIX + path, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload),
              }).then(function (body) {
                setBusy(false)
                if (!body || body.ok === false) { note.style.color = '#dc2626'; note.textContent = (body && body.error && body.error.message) || '操作失败'; return }
                var v = body.value || {}
                note.style.color = '#16a34a'
                var asModeEff = installed ? true : asMode
                if (asModeEff) note.textContent = (v.guidance || (tg('dialog.doneMode') + (v.modeName || v.presetId || '') + tg('dialog.doneModeTail'))) + (v.needsRestart ? tg('dialog.restart') : '')
                else note.textContent = tg('dialog.donePlain') + (v.bundle ? ' · ' + v.bundle : '') + (v.needsRestart ? tg('dialog.restart') : '')
                if (plainBtn) plainBtn.style.display = 'none'; modeBtn.style.display = 'none'
              }).catch(function (e) { setBusy(false); note.style.color = '#dc2626'; note.textContent = String((e && e.message) || e) })
            }
            if (plainBtn) plainBtn.onclick = function () { submit(false) }
            modeBtn.onclick = function () { submit(true) }
            if (specInput) specInput.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !busy) submit(true) })
            else nameInput.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !busy) submit(true) })

            document.body.appendChild(overlay)
            try { (specInput || nameInput).focus() } catch (e) {}
          }
      }

      function apply(ctx) {
        var t = ctx.locale.bind(NS)

        function install(label, run) {
          try { return run() } catch (error) {
            try { ctx.logger.error('[plugin2preset] ' + label + ' failed: ' + String((error && error.stack) || error)) } catch (e) {}
            return undefined
          }
        }

        install('global helper', function () {
          return ctx.effect(function () { installGlobalHelper(); return function () {} }, 'dsh-plugin2preset: helper')
        })

        install('locale dictionaries', function () {
          return ctx.effect(function () { return ctx.locale.register(NS, dictionaries) }, 'dsh-plugin2preset: dictionaries')
        })

        install('add plugin action', function () {
          return ctx.slots.inject('plugins.add.actions', function () {
            return ctx.slots.register(
              { name: 'plugins.add.actions', id: 'plugin2preset.add', order: 90, label: function () { return t('add.row.title') } },
              function (owner) { return h(AddActionRow, { t: t, onDismiss: owner && owner.onDismiss }) },
            )
          })
        })

        install('detail action', function () {
          return ctx.slots.inject('plugins.detail.actions', function () {
            return ctx.slots.register(
              { name: 'plugins.detail.actions', id: 'plugin2preset.detail', order: 90 },
              function (owner) { return h(DetailAction, { t: t, subject: owner && owner.subject }) },
            )
          })
        })
      }

      return { name: MODULE_ID, inject: ['slots', 'locale'], apply: apply }
    },
  })
})()
