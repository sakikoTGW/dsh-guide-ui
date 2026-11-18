window.__ModuleLoader__.load({
  id: 'dsh-guide-ui',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-guide'
    const CSS =
      '.dsh-guide-badge{display:inline-flex;align-items:center;gap:6px;height:calc(28px + var(--dsh-content-font-delta,0px));' +
      'padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:transparent;' +
      'color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer;' +
      'transition:background-color .1s,border-color .1s,color .1s}' +
      '.dsh-guide-badge:hover{background:var(--dsw-alias-bg-layer-2)}' +
      '.dsh-guide-badge[data-on]{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);' +
      'background:var(--dsw-alias-bg-layer-1)}' +
      '.dsh-guide-badge:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}' +
      '.dsh-guide-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}' +
      '.dsh-guide-badge[data-on] .dsh-guide-dot{background:var(--dsw-alias-state-success-primary)}' +
      '.dsh-guide-count{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;font-size:11px}' +
      '@keyframes dsh-guide-pulse{0%{box-shadow:0 0 0 0 var(--dsw-alias-state-success-primary)}100%{box-shadow:0 0 0 7px transparent}}' +
      '.dsh-guide-badge[data-pulse]{animation:dsh-guide-pulse .9s ease-out}' +
      '@keyframes dsh-guide-in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}' +
      '.dsh-guide-status{display:flex;align-items:center;gap:8px;margin:0 16px 6px;padding:6px 10px;' +
      'border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);' +
      'color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;animation:dsh-guide-in .18s ease-out}' +
      '.dsh-guide-status[data-read]{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}' +
      '.dsh-guide-status-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-state-success-primary)}' +
      '[data-dsh-guide-queued]{display:none !important}' +
      '@media (prefers-reduced-motion:reduce){.dsh-guide-status,.dsh-guide-badge[data-pulse]{animation:none}}'

    function installStyles() {
      const tag = document.createElement('style')
      tag.dataset.dshGuide = '1'
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    async function readState(sessionId) {
      const response = await fetch('/dsh-guide/state?session=' + encodeURIComponent(String(sessionId)), {
        cache: 'no-store',
      })
      if (!response.ok) return null
      return response.json()
    }

    function GuideBadge(props) {
      const sessionId = props.sessionId
      const t = props.t
      const [snapshot, setSnapshot] = React.useState(null)
      const [pulse, setPulse] = React.useState(false)

      React.useEffect(() => {
        let disposed = false
        let timer = 0
        const load = async () => {
          try {
            const next = await readState(sessionId)
            if (disposed || next === null) return
            setSnapshot((previous) =>
              previous !== null && previous.revision === next.revision ? previous : next,
            )
          } catch (error) {
            console.error('[dsh-guide] state read failed', error)
          }
        }
        load()
        timer = setInterval(load, 3000)
        return () => {
          disposed = true
          clearInterval(timer)
        }
      }, [sessionId])

      const count = snapshot !== null && typeof snapshot.injected === 'number' ? snapshot.injected : 0

      React.useEffect(() => {
        if (count <= 0) return
        setPulse(true)
        const timer = setTimeout(() => setPulse(false), 900)
        return () => clearTimeout(timer)
      }, [count])

      const enabled = snapshot === null ? true : snapshot.enabled !== false

      const toggle = async () => {
        const next = !enabled
        setSnapshot((previous) => ({ ...(previous || {}), enabled: next }))
        if (props.syncFlow && typeof props.syncFlow.set === 'function') props.syncFlow.set(next)
        try {
          const response = await fetch('/dsh-guide/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: next, sessionId: String(sessionId) }),
          })
          if (response.ok) setSnapshot(await response.json())
        } catch (error) {
          console.error('[dsh-guide] toggle failed', error)
        }
      }

      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-guide-badge',
          'data-on': enabled ? '1' : undefined,
          'data-pulse': pulse ? '1' : undefined,
          'aria-pressed': enabled,
          title: enabled ? t('titleOn') : t('titleOff'),
          onClick: toggle,
        },
        h('span', { className: 'dsh-guide-dot', 'aria-hidden': 'true' }),
        h('span', null, t('label')),
        count > 0 ? h('span', { className: 'dsh-guide-count' }, String(count)) : null,
      )
    }

    /** The felt moment: "delivered" when the message arrives, "read" when the model consumes it. */
    function GuideStatus(props) {
      const sessionId = props.sessionId
      const t = props.t
      const [snapshot, setSnapshot] = React.useState(null)

      React.useEffect(() => {
        let disposed = false
        let timer = 0
        const load = async () => {
          try {
            const next = await readState(sessionId)
            if (disposed || next === null) return
            setSnapshot((previous) =>
              previous !== null && previous.revision === next.revision ? previous : next,
            )
          } catch (error) {
            console.error('[dsh-guide] state read failed', error)
          }
        }
        load()
        timer = setInterval(load, 1000)
        return () => {
          disposed = true
          clearInterval(timer)
        }
      }, [sessionId])

      if (snapshot === null || snapshot.enabled !== true) return null
      // Only the delivered state is shown: the queue step must stay invisible.
      const delivered = typeof snapshot.injectedAt === 'number' ? snapshot.injectedAt : 0
      if (delivered === 0 || Date.now() - delivered > 8000) return null

      return h(
        'div',
        { className: 'dsh-guide-status', 'data-read': '1', role: 'status' },
        h('span', { className: 'dsh-guide-status-dot', 'aria-hidden': 'true' }),
        h('span', null, t('statusSent')),
      )
    }

    /**
     * The composer's busy-send preference (`busyEnter`: 'queue' | 'steer') is the
     * thing that decides whether a message waits in the queue or flows into the
     * running turn. Guidance is only useful when it flows, so while this plugin is
     * on, the preference is held at 'steer' and the user's own value is restored
     * when it is turned off.
     */
    const composerForm = (ctx) => {
      try {
        const service = ctx.configForms || (typeof ctx.get === 'function' ? ctx.get('configForms') : null)
        if (!service || typeof service.get !== 'function') return null
        const form = service.get('ui-conversation')
        return form && typeof form.set === 'function' ? form : null
      } catch (error) {
        return null
      }
    }

    function makeFlowSync(ctx) {
      let wanted = false
      let previous = null

      const form = () => composerForm(ctx)

      const apply = () => {
        const host = form()
        if (host === null) return false
        try {
          const value = host.getSnapshot?.()?.value
          const current = value && value.busyEnter ? value.busyEnter : 'queue'
          if (wanted) {
            if (previous === null) previous = current === 'steer' ? 'steer' : current
            if (current !== 'steer') host.set('busyEnter', 'steer')
          } else if (previous !== null) {
            host.set('busyEnter', previous)
            previous = null
          }
          return true
        } catch (error) {
          return false
        }
      }

      /**
       * Last resort when the preference cannot be written: a queued message shows a
       * card whose steer control is the DSH `queue.steer` action. Hide that card on
       * sight, then trigger its own steer action so the message joins the running
       * turn without the user ever seeing the queue step.
       *
       * The selector is attribute-substring so the scan touches only steer buttons
       * instead of every labelled button in the window.
       */
      const STEER_BUTTONS = 'button[aria-label*="插话发送"], button[aria-label*="Steer"], button[aria-label*="steer"]'

      const flushQueued = () => {
        if (!wanted) return
        for (const button of document.querySelectorAll(STEER_BUTTONS)) {
          if (button.dataset.dshGuideFlushed === '1') continue
          if (button.offsetParent === null) continue
          const card = button.closest('li, [role="listitem"]') || button.parentElement
          if (card !== null && card.dataset) card.dataset.dshGuideQueued = '1'
          if (button.disabled === true) continue
          button.dataset.dshGuideFlushed = '1'
          try {
            button.click()
          } catch (error) { /* the card may already be leaving */ }
        }
      }

      // The config form mounts later than this plugin on some launches, and a queue
      // card can appear before the preference lands. A queue card is a DOM insertion,
      // so follow mutations while the switch is on and keep one slow safety pass
      // instead of scanning the whole document six times a second.
      let settled = false
      const pass = () => {
        if (!wanted) return
        if (!settled) settled = apply()
        flushQueued()
      }

      let pending = 0
      const observer = new MutationObserver(() => {
        if (!wanted || pending !== 0) return
        pending = setTimeout(() => {
          pending = 0
          flushQueued()
        }, 80)
      })
      if (document.body !== null) observer.observe(document.body, { childList: true, subtree: true })
      const timer = setInterval(pass, 800)

      return {
        set(enabled) {
          wanted = enabled
          if (enabled) {
            settled = apply()
            flushQueued()
          } else {
            apply()
          }
        },
        dispose() {
          clearInterval(timer)
          clearTimeout(pending)
          observer.disconnect()
        },
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const syncFlow = makeFlowSync(ctx)
        ctx.effect(() => () => syncFlow.dispose(), 'dsh-guide: composer flow')
        void (async () => {
          try {
            const response = await fetch('/dsh-guide/state', { cache: 'no-store' })
            if (!response.ok) return
            const state = await response.json()
            syncFlow.set(state.enabled !== false)
          } catch (error) { /* preference is best effort */ }
        })()
        ctx.effect(() => installStyles(), 'dsh-guide: styles')
        ctx.effect(
          () =>
            ctx.locale.register(NS, {
              zh: {
                label: '引导',
                titleOn: '运行中引导：开 · 点击关闭',
                titleOff: '运行中引导：关 · 点击开启',
                statusSent: '已作为引导送达',
              },
              en: {
                label: 'Guide',
                titleOn: 'Mid-task guidance: on · click to turn off',
                titleOff: 'Mid-task guidance: off · click to turn on',
                statusSent: 'Delivered as guidance',
              },
            }),
          'dsh-guide: dictionaries',
        )
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: 'guide', order: 30 },
            (props) => h(GuideBadge, { ...props, t, syncFlow }),
          ),
        )
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            { name: 'conversation.input.dock', id: 'guide-status', order: 40 },
            (props) => h(GuideStatus, { ...props, t }),
          ),
        )
      },
    }
  },
})
