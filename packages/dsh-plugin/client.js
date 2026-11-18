/**
 * SQL Approval Gateway — DSH Client half (P3-b).
 *
 * Registers one right-sidebar tab whose body embeds the gateway's approval
 * console (`{core}/?embed=1`). The pane never reads or writes a token:
 * authentication lives in the iframe document, which is the gateway's origin.
 * If the host page's CSP blocks the frame, a degraded "open console" fallback
 * is shown with the reason.
 */
window.__ModuleLoader__.load({
  id: '@sql-approval/dsh',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useMemo, useRef, useState } = React;

    const TAB_ID = '@sql-approval/dsh';
    const TAB_KIND = 'sql-approval';
    const DEFAULT_CORE_URL = 'http://127.0.0.1:43119';
    const CONFIG_PATHS = ['/api/sql-approval/client-config', '/sql-approval/client-config'];
    const HANDSHAKE_TIMEOUT_MS = 4000;

    const T = {
      bg: 'var(--dsw-alias-bg-base)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      border1: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      text: 'var(--dsw-alias-label-primary)',
      text2: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
    };

    const DICT = {
      zh: {
        title: 'SQL 审批',
        guideDescription: '提交、审批并查看只读 SQL 提案。',
        open: '打开审批台',
        loading: '正在连接审批台…',
        frameTitle: 'SQL 审批台',
        blockedTitle: '审批台无法内嵌显示',
        blockedCsp: '内容安全策略（CSP）拦截了 iframe。',
        blockedNetwork: '审批台加载失败，无法连接 core。',
        blockedHint: '请点击「打开审批台」在新窗口中使用完整审批功能。',
        retry: '重试',
        handshakeWarning:
          '未收到审批台握手（child hello）；可能是 CSP、core 未启动，或 SPA 不支持 embed。',
        configNote: '未读取到插件配置，使用默认 core 地址。',
      },
      en: {
        title: 'SQL approvals',
        guideDescription: 'Submit, approve, and inspect read-only SQL proposals.',
        open: 'Open approval console',
        loading: 'Connecting to the approval console…',
        frameTitle: 'SQL approval console',
        blockedTitle: 'The approval console cannot be embedded',
        blockedCsp: 'The Content Security Policy (CSP) blocked the iframe.',
        blockedNetwork: 'The approval console failed to load; core is unreachable.',
        blockedHint: 'Use “Open approval console” to continue in a new window.',
        retry: 'Retry',
        handshakeWarning:
          'No child hello received. CSP may block the iframe, core may be down, or the SPA may not support embed mode.',
        configNote: 'Plugin configuration was unavailable; using the default core address.',
      },
    };

    function detectLang() {
      try {
        if (navigator.language && !navigator.language.toLowerCase().startsWith('zh')) return 'en';
      } catch {
        /* ignore */
      }
      return 'zh';
    }

    const lang = detectLang();
    const t = (key) => (DICT[lang] && DICT[lang][key]) || DICT.zh[key] || key;

    function normalizeCoreUrl(value) {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      if (!/^https?:\/\//i.test(trimmed)) return null;
      try {
        const parsed = new URL(trimmed);
        if (!parsed.hostname) return null;
        return trimmed.replace(/\/+$/, '');
      } catch {
        return null;
      }
    }

    function originOf(value) {
      try {
        return new URL(value).origin;
      } catch {
        return null;
      }
    }

    function embedUrl(coreUrl) {
      return `${coreUrl.replace(/\/+$/, '')}/?embed=1`;
    }

    async function loadCoreUrl() {
      const override = normalizeCoreUrl(window.__SAG_URL__);
      if (override) return { url: override, fallback: false };

      for (const path of CONFIG_PATHS) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1500);
        try {
          const response = await fetch(path, {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
            signal: controller.signal,
          });
          if (!response.ok) continue;
          const payload = await response.json();
          const url = normalizeCoreUrl(payload && payload.core_url);
          if (url) return { url, fallback: false };
        } catch {
          /* try the next path */
        } finally {
          clearTimeout(timer);
        }
      }

      return { url: DEFAULT_CORE_URL, fallback: true };
    }

    const styles = {
      wrap: {
        height: '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        color: T.text,
        background: T.bg,
        boxSizing: 'border-box',
      },
      header: {
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 8,
        padding: '8px 10px',
        borderBottom: `1px solid ${T.border1}`,
      },
      title: {
        fontSize: 13,
        fontWeight: 600,
        marginRight: 'auto',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      link: {
        display: 'inline-flex',
        alignItems: 'center',
        padding: '3px 9px',
        borderRadius: 6,
        border: `1px solid ${T.border2}`,
        color: T.text,
        textDecoration: 'none',
        whiteSpace: 'nowrap',
        fontSize: 12,
      },
      frame: {
        flex: '1 1 auto',
        display: 'block',
        width: '100%',
        minHeight: 0,
        border: 0,
        background: T.bg,
      },
      muted: { color: T.text2, fontSize: 12, lineHeight: 1.6 },
      notice: {
        flex: '0 0 auto',
        margin: '8px 10px',
        padding: '7px 9px',
        borderRadius: 6,
        border: `1px solid ${T.border2}`,
        background: T.layer1,
        color: T.text2,
        fontSize: 12,
        lineHeight: 1.55,
      },
      noticeWarn: { color: T.warn },
      loading: {
        flex: '1 1 auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: T.text2,
        fontSize: 12,
      },
      fallback: {
        flex: '1 1 auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        justifyContent: 'center',
        gap: 8,
        padding: 18,
      },
      fallbackTitle: { color: T.err, fontSize: 13, fontWeight: 600 },
      buttonLink: {
        display: 'inline-flex',
        alignItems: 'center',
        padding: '4px 11px',
        borderRadius: 6,
        border: `1px solid ${T.brand}`,
        color: T.brand,
        textDecoration: 'none',
        fontSize: 12,
      },
      retry: {
        padding: '3px 9px',
        borderRadius: 6,
        border: `1px solid ${T.border2}`,
        background: 'transparent',
        color: T.text,
        cursor: 'pointer',
        fontSize: 12,
      },
    };

    function ApprovalPane() {
      const [coreUrl, setCoreUrl] = useState(DEFAULT_CORE_URL);
      const [ready, setReady] = useState(false);
      const [configFallback, setConfigFallback] = useState(false);
      const [blocked, setBlocked] = useState(null);
      const [handshake, setHandshake] = useState('waiting');
      const [reloadKey, setReloadKey] = useState(0);
      const frameRef = useRef(null);
      const handshakeRef = useRef('waiting');
      const frameSrc = useMemo(() => embedUrl(coreUrl), [coreUrl]);
      const coreOrigin = useMemo(() => originOf(coreUrl), [coreUrl]);

      useEffect(() => {
        let alive = true;
        loadCoreUrl().then((result) => {
          if (!alive) return;
          setCoreUrl(result.url);
          setConfigFallback(result.fallback);
          setReady(true);
        });
        return () => {
          alive = false;
        };
      }, []);

      // A per-frame handshake timer: `iframe load` also fires when the frame is
      // rejected, so only a child hello proves the console is actually running.
      useEffect(() => {
        handshakeRef.current = 'waiting';
        setHandshake('waiting');
        const timer = setTimeout(() => {
          if (handshakeRef.current === 'waiting') {
            handshakeRef.current = 'timeout';
            setHandshake('timeout');
          }
        }, HANDSHAKE_TIMEOUT_MS);
        return () => clearTimeout(timer);
      }, [coreUrl, reloadKey]);

      useEffect(() => {
        const onViolation = (event) => {
          if (event.disposition && event.disposition !== 'enforce') return;
          const directive = String(event.effectiveDirective || event.violatedDirective || '');
          if (!/^(frame-src|child-src|default-src)$/.test(directive)) return;
          const blockedUri = String(event.blockedURI || '');
          if (blockedUri && coreOrigin && !blockedUri.startsWith(coreOrigin)) return;
          setBlocked({ kind: 'csp', detail: directive });
        };

        const onMessage = (event) => {
          if (!coreOrigin || event.origin !== coreOrigin) return;
          const frameWindow = frameRef.current && frameRef.current.contentWindow;
          if (frameWindow && event.source && event.source !== frameWindow) return;
          handshakeRef.current = 'ok';
          setHandshake('ok');
          setBlocked(null);
        };

        document.addEventListener('securitypolicyviolation', onViolation);
        window.addEventListener('message', onMessage);
        return () => {
          document.removeEventListener('securitypolicyviolation', onViolation);
          window.removeEventListener('message', onMessage);
        };
      }, [coreOrigin]);

      const retry = () => {
        handshakeRef.current = 'waiting';
        setHandshake('waiting');
        setBlocked(null);
        setReloadKey((value) => value + 1);
      };

      const openLink = h(
        'a',
        {
          href: frameSrc,
          target: '_blank',
          rel: 'noopener noreferrer',
          style: styles.link,
          title: t('open'),
        },
        t('open'),
      );

      let body = null;
      if (!ready) {
        body = h('div', { style: styles.loading }, t('loading'));
      } else if (blocked) {
        const reason =
          blocked.kind === 'csp'
            ? `${t('blockedCsp')}${blocked.detail ? ` (${blocked.detail})` : ''}`
            : t('blockedNetwork');
        body = h(
          'div',
          { style: styles.fallback },
          h('div', { style: styles.fallbackTitle }, t('blockedTitle')),
          h('div', { style: styles.muted }, reason),
          h('div', { style: styles.muted }, t('blockedHint')),
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 } },
            h(
              'a',
              {
                href: frameSrc,
                target: '_blank',
                rel: 'noopener noreferrer',
                style: styles.buttonLink,
              },
              t('open'),
            ),
            h('button', { type: 'button', style: styles.retry, onClick: retry }, t('retry')),
          ),
        );
      } else {
        body = h('iframe', {
          key: reloadKey,
          ref: frameRef,
          src: frameSrc,
          title: t('frameTitle'),
          referrerPolicy: 'no-referrer',
          style: styles.frame,
          onError: () => setBlocked({ kind: 'network', detail: '' }),
        });
      }

      return h(
        'div',
        { style: styles.wrap },
        h('div', { style: styles.header }, h('strong', { style: styles.title }, t('title')), openLink),
        configFallback && ready
          ? h('div', { style: { ...styles.notice, ...styles.noticeWarn } }, t('configNote'))
          : null,
        handshake === 'timeout' && !blocked
          ? h(
              'div',
              { style: { ...styles.notice, ...styles.noticeWarn } },
              t('handshakeWarning'),
            )
          : null,
        body,
      );
    }

    return {
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight'],
      apply(ctx) {
        const tabs = ctx.sidebarRightTabs;
        if (!tabs || typeof tabs.register !== 'function') {
          console.error(
            'sql-approval: sidebarRightTabs 不可用；请确认 @deepseek-ai/dsh-client-ui-sidebar-right 已启用。',
          );
          return;
        }

        ctx.effect(
          () =>
            tabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              title: () => t('title'),
              keepMounted: true,
              guide: [
                {
                  id: TAB_ID,
                  title: () => t('title'),
                  description: () => t('guideDescription'),
                },
              ],
            }),
          `${TAB_ID}.tab-type`,
        );

        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register(
            {
              name: 'sidebar.right.pane.tab',
              key: TAB_ID,
            },
            ApprovalPane,
          ),
        );

        const nav = ctx.sidebarRight;
        if (nav && typeof nav.openTab === 'function') {
          ctx.effect(() => {
            try {
              nav.openTab(TAB_KIND, { revealIfOpened: true });
            } catch (error) {
              console.error('sql-approval: 打开右侧栏 tab 失败', error);
            }
          }, `${TAB_ID}.auto-open`);
        }
      },
    };
  },
});
