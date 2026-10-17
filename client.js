window.__ModuleLoader__.load({
  id: 'dsh-opencode-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'opencode-bridge'
    const zh = {
      title: 'OpenCode 桥',
      subtitle: '隔离的真实 opencode 运行时 · 免费模型接入',
      phase: '状态',
      running: '运行中',
      starting: '启动中',
      error: '异常',
      models: '免费模型',
      version: '运行时版本',
      uptime: '已运行',
      updated: '读取时间',
      lastError: '最近错误',
      none: '无',
      modelsTitle: '模型清单',
      loading: '读取中…',
    }
    const en = {
      title: 'OpenCode Bridge',
      subtitle: 'Isolated real opencode runtime · free models',
      phase: 'Status',
      running: 'Running',
      starting: 'Starting',
      error: 'Error',
      models: 'Free models',
      version: 'Runtime',
      uptime: 'Uptime',
      updated: 'Updated',
      lastError: 'Last error',
      none: 'None',
      modelsTitle: 'Models',
      loading: 'Loading…',
    }

    const label = { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }
    const value = { color: 'var(--dsw-alias-label-primary)', fontSize: 13, fontWeight: 500 }

    function formatUptime(ms) {
      if (!Number.isFinite(ms) || ms < 0) return '—'
      const s = Math.floor(ms / 1000)
      const hh = Math.floor(s / 3600)
      const mm = Math.floor((s % 3600) / 60)
      const ss = s % 60
      return hh > 0 ? `${hh}h ${mm}m` : mm > 0 ? `${mm}m ${ss}s` : `${ss}s`
    }

    function phaseColor(phase) {
      if (phase === 'ready') return 'var(--dsw-alias-state-success-primary)'
      if (phase === 'error') return 'var(--dsw-alias-state-error-primary)'
      return 'var(--dsw-alias-state-warn-primary)'
    }

    function useStatus() {
      const [status, setStatus] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const response = await fetch('/api/opencode-bridge/status', { cache: 'no-store' })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const body = await response.json()
            if (alive) setStatus(body)
          } catch (error) {
            if (alive) setStatus({ phase: 'error', lastError: String(error && error.message ? error.message : error) })
          }
        }
        void tick()
        const timer = setInterval(tick, 5000)
        return () => { alive = false; clearInterval(timer) }
      }, [])
      return status
    }

    function Field({ name, text }) {
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 110 } },
        h('span', { style: label }, name),
        h('span', { style: value }, text))
    }

    function Card() {
      const status = useStatus()
      const t = React.useContext(LocaleContext)
      const phase = status ? status.phase : 'starting'
      const phaseText = phase === 'ready' ? t('running') : phase === 'error' ? t('error') : t('starting')
      const models = status && Array.isArray(status.ids) ? status.ids : []
      const now = Date.now()

      return h('div', {
        style: {
          display: 'flex', flexDirection: 'column', gap: 14,
          padding: 18, borderRadius: 14,
          background: 'var(--dsw-alias-bg-layer-1)',
          border: '1px solid var(--dsw-alias-border-l1)',
          color: 'var(--dsw-alias-label-primary)',
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          h('span', {
            style: {
              width: 10, height: 10, borderRadius: 999,
              background: phaseColor(phase),
              boxShadow: `0 0 0 3px color-mix(in srgb, ${phaseColor(phase)} 22%, transparent)`,
            },
          }),
          h('div', { style: { display: 'flex', flexDirection: 'column' } },
            h('span', { style: { fontSize: 15, fontWeight: 600 } }, t('title')),
            h('span', { style: { ...label, marginTop: 2 } }, t('subtitle'))),
          h('span', { style: { marginLeft: 'auto', fontSize: 12, color: phaseColor(phase), fontWeight: 600 } }, phaseText)),

        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 18 } },
          h(Field, { name: t('models'), text: status ? String(status.models ?? models.length) : '—' }),
          h(Field, { name: t('version'), text: status && status.version ? status.version : '—' }),
          h(Field, { name: t('uptime'), text: status && status.uptimeMs != null ? formatUptime(status.uptimeMs) : '—' }),
          h(Field, { name: t('updated'), text: status && status.writtenAt ? new Date(status.writtenAt).toLocaleTimeString() : (status ? new Date(now).toLocaleTimeString() : '—') })),

        models.length > 0
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              h('span', { style: label }, t('modelsTitle')),
              h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                models.map(id => h('span', {
                  key: id,
                  style: {
                    fontSize: 12, padding: '3px 9px', borderRadius: 999,
                    background: 'var(--dsw-alias-bg-layer-2)',
                    border: '1px solid var(--dsw-alias-border-l1)',
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                }, id))))
          : h('span', { style: label }, status ? '' : t('loading')),

        status && status.lastError
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              h('span', { style: label }, t('lastError')),
              h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)', wordBreak: 'break-all' } }, status.lastError))
          : null)
    }

    const LocaleContext = React.createContext((key) => key)

    const inject = ['slots', 'locale']

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'opencode-bridge: copy')
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'opencode-bridge',
        order: 25,
        label: () => t('title'),
      }, function Section() {
        return h(LocaleContext.Provider, { value: t }, h(Card))
      }))
    }

    const module = { exports: {} }
    module.exports = { apply, inject, NS }
    return module.exports
  },
})
