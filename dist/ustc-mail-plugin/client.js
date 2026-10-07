/**
 * Client half of the USTC mail plugin.
 *
 * Two registrations make one feature:
 *
 *   sidebar.panellist, id  'ustc-mail'  -> the icon button in the left rail
 *   main,             key 'ustc-mail'   -> the panel that button selects
 *
 * The sidebar owns the button and matches it to the panel by that shared id, so
 * both registrations must use exactly the same value.
 *
 * Data comes from the Host half over a same-origin HTTP route rather than
 * through a Client service: a plain-JavaScript plugin may not import a Harness
 * Client package, and the slot context exposes no mail service. See index.js for
 * the route.
 *
 * Plain JavaScript on purpose. The module loader hands over React from the
 * browser module table; nothing is imported from the Harness.
 */
window.__ModuleLoader__.load({
  id: '@local/ustc-mail',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Route prefix registered by the Host half. */
    const API = '/ustc-mail/api';

    /** Text kept in one place so a locale switch has a single input. */
    const STRINGS = {
      zh: {
        title: '科大邮箱',
        refresh: '刷新',
        search: '在主题、发件人与正文中搜索',
        searchAction: '搜索',
        clear: '返回列表',
        loading: '正在读取……',
        empty: '没有匹配的邮件。',
        unread: '未读',
        attachments: '有附件',
        failed: '读取失败',
        hint: '在左侧搜索或刷新以查看最近的邮件。',
      },
      en: {
        title: 'USTC Mail',
        refresh: 'Refresh',
        search: 'Search subject, sender, and body',
        searchAction: 'Search',
        clear: 'Back to list',
        loading: 'Loading…',
        empty: 'No matching messages.',
        unread: 'Unread',
        attachments: 'Has attachments',
        failed: 'Could not load',
        hint: 'Search or refresh to see recent mail.',
      },
    };

    /** Read the active locale without depending on a service that may be absent. */
    function readStrings(ctx) {
      let id = 'zh';
      try {
        const snapshot = ctx.locale.getLocale();
        const candidate = snapshot && (snapshot.id || snapshot.locale || snapshot.language);
        if (typeof candidate === 'string' && candidate.toLowerCase().startsWith('en')) id = 'en';
      } catch {
        // A missing locale service must not blank the panel.
      }
      return STRINGS[id];
    }

    /** Tokens only; literal colors are reserved for the icon artwork. */
    const CSS = `
.ustc-mail-root {
  display: flex; flex-direction: column; height: 100%; min-height: 0;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font-size: 13px;
}
.ustc-mail-bar {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1);
  flex: 0 0 auto;
}
.ustc-mail-bar h1 { font-size: 14px; font-weight: 600; margin: 0; }
.ustc-mail-count { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.ustc-mail-spacer { flex: 1 1 auto; }
.ustc-mail-input {
  flex: 1 1 auto; min-width: 0; height: 30px; padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font: inherit; outline: none;
}
.ustc-mail-input:focus { border-color: var(--dsw-alias-brand-primary); }
.ustc-mail-button {
  height: 30px; padding: 0 12px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font: inherit;
}
.ustc-mail-button:hover { background: var(--dsw-alias-bg-layer-2); }
.ustc-mail-button[disabled] { opacity: .5; cursor: default; }
.ustc-mail-body { flex: 1 1 auto; min-height: 0; overflow: auto; }
.ustc-mail-row {
  display: block; width: 100%; text-align: left; cursor: pointer;
  padding: 10px 16px; border: 0; border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: transparent; color: inherit; font: inherit;
}
.ustc-mail-row:hover { background: var(--dsw-alias-bg-layer-1); }
.ustc-mail-row-top { display: flex; align-items: baseline; gap: 8px; }
.ustc-mail-subject {
  flex: 1 1 auto; min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; font-weight: 500;
}
.ustc-mail-date { flex: 0 0 auto; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.ustc-mail-from {
  margin-top: 2px; color: var(--dsw-alias-label-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ustc-mail-tags { display: flex; gap: 6px; margin-top: 4px; }
.ustc-mail-tag {
  font-size: 11px; padding: 1px 6px; border-radius: 4px;
  border: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
}
.ustc-mail-tag-unread {
  color: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
}
.ustc-mail-detail { padding: 16px; }
.ustc-mail-detail h2 { font-size: 14px; margin: 0 0 8px; font-weight: 600; }
.ustc-mail-meta { color: var(--dsw-alias-label-secondary); margin-bottom: 12px; line-height: 1.6; }
.ustc-mail-text {
  white-space: pre-wrap; word-break: break-word; line-height: 1.6;
  border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 12px;
}
.ustc-mail-note { padding: 24px 16px; color: var(--dsw-alias-label-secondary); }
.ustc-mail-error { padding: 16px; color: var(--dsw-alias-state-error-primary); }
`;

    /** @returns a stylesheet element scoped to this plugin. */
    function Styles() {
      return h('style', { 'data-ustc-mail': 'styles' }, CSS);
    }

    /** The left-rail icon. Receives `size` and `active` from the sidebar owner. */
    function MailIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 18;
      const active = Boolean(props && props.active);
      return h(
        'svg',
        {
          width: size, height: size, viewBox: '0 0 24 24',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
          strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': true, style: { display: 'block' },
          opacity: active ? 1 : 0.72,
        },
        h('rect', { x: 3, y: 5.5, width: 18, height: 13, rx: 2.5 }),
        h('path', { d: 'M3.6 7.4l7.3 5.2c.7.5 1.5.5 2.2 0l7.3-5.2' }),
      );
    }

    /** One message row. */
    function Row(props) {
      const m = props.message;
      const t = props.strings;
      return h(
        'button',
        { type: 'button', className: 'ustc-mail-row', onClick: () => props.onOpen(m.uid) },
        h(
          'div',
          { className: 'ustc-mail-row-top' },
          h('span', { className: 'ustc-mail-subject' }, m.subject || '(no subject)'),
          h('span', { className: 'ustc-mail-date' }, m.date || ''),
        ),
        h('div', { className: 'ustc-mail-from' }, m.from || ''),
        (m.unread || m.hasAttachments)
          ? h(
            'div',
            { className: 'ustc-mail-tags' },
            m.unread ? h('span', { className: 'ustc-mail-tag ustc-mail-tag-unread' }, t.unread) : null,
            m.hasAttachments ? h('span', { className: 'ustc-mail-tag' }, t.attachments) : null,
          )
          : null,
      );
    }

    /** One message, opened. */
    function Detail(props) {
      const m = props.message;
      const t = props.strings;
      const attachments = Array.isArray(m.attachments) ? m.attachments : [];
      return h(
        'div',
        { className: 'ustc-mail-detail' },
        h('h2', null, m.subject || '(no subject)'),
        h(
          'div',
          { className: 'ustc-mail-meta' },
          h('div', null, m.from || ''),
          h('div', null, m.date || ''),
          attachments.length > 0
            ? h('div', null, attachments.map((a) => a.filename).join(', '))
            : null,
          m.bodyTruncated ? h('div', null, '…') : null,
        ),
        h('div', { className: 'ustc-mail-text' }, m.body || h('em', null, t.empty)),
      );
    }

    /** The panel itself. */
    function MailPanel(props) {
      const ctx = props.ctx;
      const t = React.useMemo(() => readStrings(ctx), [ctx]);
      const [state, setState] = React.useState({ phase: 'idle', messages: [], exists: 0 });
      const [open, setOpen] = React.useState(null);
      const [term, setTerm] = React.useState('');

      const load = React.useCallback(async (query) => {
        setState((s) => ({ ...s, phase: 'loading' }));
        try {
          const url = query
            ? `${API}/search?anywhere=${encodeURIComponent(query)}&limit=30`
            : `${API}/list?limit=30`;
          const response = await fetch(url, { headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          setState({ phase: 'ready', messages: data.messages || [], exists: data.exists || 0 });
        } catch (error) {
          setState({ phase: 'error', messages: [], exists: 0, error: String(error && error.message) });
        }
      }, []);

      React.useEffect(() => { load(''); }, [load]);

      const openMessage = React.useCallback(async (uid) => {
        setOpen({ loading: true, uid });
        try {
          const response = await fetch(`${API}/read?uid=${uid}&maxChars=4000`, {
            headers: { accept: 'application/json' },
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          setOpen(await response.json());
        } catch (error) {
          setOpen({ error: String(error && error.message), uid });
        }
      }, []);

      const bar = h(
        'div',
        { className: 'ustc-mail-bar' },
        h('h1', null, t.title),
        h(
          'span',
          { className: 'ustc-mail-count' },
          state.phase === 'ready' ? `${state.messages.length} / ${state.exists}` : '',
        ),
        h('span', { className: 'ustc-mail-spacer' }),
        h('input', {
          className: 'ustc-mail-input',
          value: term,
          placeholder: t.search,
          onChange: (e) => setTerm(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') { setOpen(null); load(term.trim()); } },
        }),
        h('button', {
          type: 'button', className: 'ustc-mail-button',
          onClick: () => { setOpen(null); load(term.trim()); },
        }, t.searchAction),
        h('button', {
          type: 'button', className: 'ustc-mail-button',
          onClick: () => { setOpen(null); setTerm(''); load(''); },
        }, t.refresh),
      );

      let body;
      if (state.phase === 'error') {
        body = h('div', { className: 'ustc-mail-error' }, `${t.failed}: ${state.error}`);
      } else if (open && open.loading) {
        body = h('div', { className: 'ustc-mail-note' }, t.loading);
      } else if (open && open.error) {
        body = h(
          'div',
          null,
          h('div', { className: 'ustc-mail-bar' },
            h('button', {
              type: 'button', className: 'ustc-mail-button', onClick: () => setOpen(null),
            }, t.clear)),
          h('div', { className: 'ustc-mail-error' }, `${t.failed}: ${open.error}`),
        );
      } else if (open) {
        body = h(
          'div',
          null,
          h('div', { className: 'ustc-mail-bar' },
            h('button', {
              type: 'button', className: 'ustc-mail-button', onClick: () => setOpen(null),
            }, t.clear)),
          h(Detail, { message: open, strings: t }),
        );
      } else if (state.phase === 'loading' || state.phase === 'idle') {
        body = h('div', { className: 'ustc-mail-note' }, t.loading);
      } else if (state.messages.length === 0) {
        body = h('div', { className: 'ustc-mail-note' }, t.empty);
      } else {
        body = state.messages.map((m) => h(Row, { key: m.uid, message: m, strings: t, onOpen: openMessage }));
      }

      return h(
        'div',
        { className: 'ustc-mail-root' },
        h(Styles),
        bar,
        h('div', { className: 'ustc-mail-body' }, body),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The rail icon. The id is what the panel below is keyed by.
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: 'ustc-mail', order: 20 },
          MailIcon,
        ));

        // The panel that icon selects; the sidebar dispatches this exact key.
        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: 'ustc-mail' },
          (props) => h(MailPanel, { ...props, ctx }),
        ));
      },
    };
  },
});
