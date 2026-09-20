/**
 * dsh-feishu-assistant — client half（Web 设置页）。
 *
 * 在设置面板注册「飞书AI助理」分区，维护三类配置：
 * - 目标会话 ID 走宿主的 settings 命名空间
 * - 人设内容存在插件自己的配置里（可手写，也可从本地文件导入）
 * - App ID / App Secret 走宿主的凭据存储（写入后不回显，只显示是否已设置）
 *
 * 页面每 3 秒拉一次宿主状态，拿长连接是否建立与最近一条错误。
 */

window.__ModuleLoader__.load({
  id: 'dsh-feishu-assistant',
  factory: (require) => {
    const module = { exports: {} };
    const React = require('react');
    const h = React.createElement;

    const STATE_ROUTE = '/dsh-feishu-assistant/state';
    const CONFIG_ROUTE = '/dsh-feishu-assistant/config';
    const CREDENTIALS_ROUTE = '/dsh-feishu-assistant/credentials';
    const SESSIONS_ROUTE = '/dsh-feishu-assistant/sessions';
    const PAIRING_ROUTE = '/dsh-feishu-assistant/pairing';
    const MAX_PERSONA_BYTES = 64 * 1024;
    const PERSONA_ACCEPT = '.md,.markdown,.txt,text/markdown,text/plain';
    const POLL_MS = 3000;
    const SESSIONS_POLL_MS = 10000;
    const LOCALE_NS = 'feishu-assistant';

    const MESSAGES = {
      zh: {
        section: '飞书AI助理',
        heading: '飞书AI助理',
        intro: '用飞书长连接驱动一条 DSH 会话：私聊消息注入该会话并唤醒它，回答回写到飞书。不需要公网入口。',
        'field.appId': 'App ID',
        'field.appSecret': 'App Secret',
        'field.sessionId': '目标会话',
        'field.persona': '人设内容',
        'hint.appSecret': '保存后不再回显；留空表示不改动。',
        'hint.sessionId': '列表是本机已有的会话；标「已打开」的能立刻收消息，没打开的要先在 Web UI 里打开它。',
        'hint.persona': '直接写，或从本地文件导入一份。内容存在插件自己的配置里（$DSH_HOME/settings.yaml），插件不会去改你的原文件。填了内容「飞书AI助理模式」才生效；清空即关闭。上限 64 KB。',
        'placeholder.persona': '在这个会话里你是谁、怎么说话、要遵守什么格式约定…',
        'button.import': '从文件导入…',
        'import.tooLarge': '这个文件超过 64 KB，没有导入',
        'session.placeholder': '（未选择）',
        'session.untitled': '（未命名）',
        'session.unknown': '（不在列表中）',
        'session.live': '已打开',
        'session.running': '运行中',
        'session.notLive': '未打开',
        'placeholder.appId': '输入 App ID',
        'placeholder.appSecret': '输入 App Secret',
        'placeholder.stored': '已配置——输入新值可替换',
        'placeholder.envLocked': '由启动环境提供（只读）',
        'button.save': '保存',
        'button.saving': '保存中…',
        'button.refresh': '刷新',
        'saved': '已保存',
        'status.title': '状态',
        'status.connection': '长连接',
        'status.connected': '已建立',
        'status.disconnected': '未建立',
        'status.appId': 'App ID',
        'status.appSecret': 'App Secret',
        'status.configured': '已设置',
        'status.notConfigured': '未设置',
        'status.source': '来源',
        'status.readOnly': '只读（被环境变量或 .env 遮蔽）',
        'status.sessionId': '当前目标会话',
        'status.sessionError': '会话错误',
        'status.personaMode': '飞书AI助理模式',
        'status.personaActive': '已启用 · {bytes} / 65536 字节',
        'status.personaInactive': '未启用（人设内容为空）',
        'status.managerId': '管理员',
        'status.managerIdNone': '未配置（谁都不会被处理）',
        'pairing.title': '配对',
        'pairing.intro': '生成口令后，在飞书里私聊机器人发送这条口令，机器人会把你的飞书 ID 直接设为管理员。口令只能用一次，10 分钟后失效。',
        'pairing.generate': '生成配对码',
        'pairing.regenerate': '重新生成',
        'pairing.expiresIn': '约 {minutes} 分钟后失效',
        'pairing.failed': '生成失败',
        'status.none': '（未设置）',
        'status.lastError': '最近错误',
      },
      en: {
        section: 'Feishu AI Assistant',
        heading: 'Feishu AI Assistant',
        intro: 'Drive a DSH session from Feishu over a long connection: direct messages are injected into the session and wake it, replies go back to Feishu. No public ingress needed.',
        'field.appId': 'App ID',
        'field.appSecret': 'App Secret',
        'field.sessionId': 'Target session',
        'field.persona': 'Persona',
        'hint.appSecret': 'Never echoed back after saving; leave blank to keep the current value.',
        'hint.sessionId': 'The list holds this machine\'s existing sessions; only the ones marked "open" can receive messages right away.',
        'hint.persona': 'Type it here, or import a local file. The text is stored in the plugin\'s own config ($DSH_HOME/settings.yaml); your original file is never touched. The Feishu assistant mode is on only while this is non-empty; clear it to turn the mode off. Cap: 64 KB.',
        'placeholder.persona': 'Who you are in this session, how you talk, what formats to follow…',
        'button.import': 'Import from file…',
        'import.tooLarge': 'That file is larger than 64 KB; nothing imported',
        'session.placeholder': '(none selected)',
        'session.untitled': '(untitled)',
        'session.unknown': '(not in list)',
        'session.live': 'open',
        'session.running': 'running',
        'session.notLive': 'closed',
        'placeholder.appId': 'Enter App ID',
        'placeholder.appSecret': 'Enter App Secret',
        'placeholder.stored': 'Configured — enter a new value to replace',
        'placeholder.envLocked': 'Provided by the launch environment (read-only)',
        'button.save': 'Save',
        'button.saving': 'Saving…',
        'button.refresh': 'Refresh',
        'saved': 'Saved',
        'status.title': 'Status',
        'status.connection': 'Long connection',
        'status.connected': 'Connected',
        'status.disconnected': 'Not connected',
        'status.appId': 'App ID',
        'status.appSecret': 'App Secret',
        'status.configured': 'Configured',
        'status.notConfigured': 'Not configured',
        'status.source': 'Source',
        'status.readOnly': 'Read-only (shadowed by an env var or .env)',
        'status.sessionId': 'Current target session',
        'status.sessionError': 'Session error',
        'status.personaMode': 'Feishu assistant mode',
        'status.personaActive': 'enabled · {bytes} / 65536 bytes',
        'status.personaInactive': 'disabled (persona is empty)',
        'status.managerId': 'Manager',
        'status.managerIdNone': 'none (nobody is served)',
        'pairing.title': 'Pairing',
        'pairing.intro': 'Generate a code, then send it to the bot in a Feishu direct message: your Feishu ID becomes the manager. The code works once and expires after 10 minutes.',
        'pairing.generate': 'Generate code',
        'pairing.regenerate': 'Regenerate',
        'pairing.expiresIn': 'expires in about {minutes} min',
        'pairing.failed': 'Failed to generate',
        'status.none': '(not set)',
        'status.lastError': 'Last error',
      },
    };

    const styles = {
      section: { padding: '16px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l2)' },
      heading: { color: 'var(--dsw-alias-label-primary)', fontSize: 14, lineHeight: '22px', fontWeight: 400 },
      intro: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: '18px', margin: '4px 0 0' },
      blockTitle: { color: 'var(--dsw-alias-label-primary)', fontSize: 13, lineHeight: '20px', margin: '16px 0 8px' },
      row: { display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 14 },
      label: { flex: '0 0 96px', display: 'inline-flex', alignItems: 'center', gap: 6, paddingTop: 7, color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '18px' },
      field: { flex: '1 1 auto', minWidth: 0 },
      dot: { boxSizing: 'border-box', borderRadius: '50%', width: 8, height: 8, flex: 'none' },
      dotConfigured: { background: 'var(--dsw-alias-state-success-primary)' },
      dotMissing: { background: 'var(--dsw-alias-state-error-primary)' },
      input: {
        boxSizing: 'border-box',
        width: '100%',
        padding: '6px 10px',
        fontSize: 13,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-specific-input-major)',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: 6,
      },
      hint: { color: 'var(--dsw-alias-label-caption)', fontSize: 11, lineHeight: '16px', marginTop: 4 },
      textarea: {
        boxSizing: 'border-box',
        width: '100%',
        minHeight: 140,
        padding: '6px 10px',
        fontSize: 13,
        lineHeight: '20px',
        fontFamily: 'var(--ds-font-family-code)',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-specific-input-major)',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: 6,
        resize: 'vertical',
      },
      actions: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, maxWidth: 420 },
      primary: {
        padding: '6px 14px',
        fontSize: 13,
        color: 'var(--dsw-alias-label-primary-foreground)',
        background: 'var(--dsw-alias-button-primary-fill)',
        border: '0.5px solid transparent',
        borderRadius: 6,
        cursor: 'pointer',
      },
      secondary: {
        padding: '6px 14px',
        fontSize: 13,
        color: 'var(--dsw-alias-label-primary)',
        background: 'transparent',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: 6,
        cursor: 'pointer',
      },
      note: { fontSize: 12, lineHeight: '18px', marginLeft: 4 },
      statusRow: { display: 'flex', gap: 8, fontSize: 12, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' },
      statusLabel: { flex: '0 0 140px', color: 'var(--dsw-alias-label-tertiary)' },
      statusError: { color: 'var(--dsw-alias-state-error-primary)', wordBreak: 'break-all' },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, lineHeight: '18px', wordBreak: 'break-all', marginTop: 8 },
      pairingBox: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 10,
        maxWidth: 420,
        padding: '10px 12px',
        background: 'var(--dsw-alias-bg-module-platform)',
        borderRadius: 8,
      },
      pairingCode: {
        fontFamily: 'var(--ds-font-family-code)',
        fontSize: 18,
        letterSpacing: '2px',
        color: 'var(--dsw-alias-label-primary)',
      },
    };

    const STATUS_KEY = {
      connected: 'status.connected',
      disconnected: 'status.disconnected',
    };

    /**
     * 构造设置分区组件。
     *
     * @param t 文案函数
     * @returns React 组件
     */
    function createSection(t) {
      function StatusRow({ label, value, error }) {
        return h('div', { style: styles.statusRow }, [
          h('span', { key: 'l', style: styles.statusLabel }, label),
          h('span', { key: 'v', style: error ? styles.statusError : undefined }, value),
        ]);
      }

      /**
       * 字段标题：已配置/缺失时在文字后面带一个状态圆点，和 Models 页的 API 密钥一致。
       *
       * @param props.htmlFor 关联的输入框 id
       * @param props.text 字段名
       * @param props.configured 是否已配置；undefined 表示该字段没有配置态
       * @returns 标题元素
       */
      function FieldLabel({ htmlFor, text, configured }) {
        const dot = configured === undefined
          ? null
          : h('span', {
            key: 'dot',
            style: { ...styles.dot, ...(configured ? styles.dotConfigured : styles.dotMissing) },
            title: configured ? t('status.configured') : t('status.notConfigured'),
            'aria-label': configured ? t('status.configured') : t('status.notConfigured'),
          });
        return h('label', { style: styles.label, htmlFor }, [h('span', { key: 't' }, text), dot]);
      }

      /**
       * 凭据输入框的占位文案：已配置就不再显示成空白，而是说明当前值与如何替换。
       *
       * @param configured 是否已配置
       * @param writable 是否可写；false 表示被环境变量或 .env 遮蔽
       * @param emptyText 未配置时的提示
       * @returns 占位文案
       */
      function credentialPlaceholder(configured, writable, emptyText) {
        if (configured && writable === false) return t('placeholder.envLocked');
        if (configured) return t('placeholder.stored');
        return emptyText;
      }

      return function Section() {
        const [snapshot, setSnapshot] = React.useState(null);
        const [sessions, setSessions] = React.useState([]);
        const [appId, setAppId] = React.useState('');
        const [appSecret, setAppSecret] = React.useState('');
        const [sessionId, setSessionId] = React.useState('');
        const [persona, setPersona] = React.useState('');
        // 隐藏的文件输入框：系统文件框只能由文件输入框唤起，按钮只负责替它挨点。
        const fileInput = React.useRef(null);
        const [saving, setSaving] = React.useState(false);
        const [note, setNote] = React.useState('');
        const [error, setError] = React.useState('');

        async function load(seed) {
          try {
            const response = await fetch(STATE_ROUTE, { credentials: 'same-origin' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const next = await response.json();
            setSnapshot(next);
            if (seed) {
              setSessionId(next.sessionId ?? '');
              setPersona(next.persona ?? '');
            }
            setError('');
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        }

        /** 生成配对口令；生成的码由下一次状态轮询带回。 */
        async function startPairing() {
          setError('');
          try {
            const response = await fetch(PAIRING_ROUTE, { method: 'POST', credentials: 'same-origin' });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
            setSnapshot(payload);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        }

        /** 拉可选会话列表；列表拉不到时下拉里只剩当前值，不影响保存。 */
        async function loadSessions() {
          try {
            const response = await fetch(SESSIONS_ROUTE, { credentials: 'same-origin' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            setSessions(Array.isArray(payload?.sessions) ? payload.sessions : []);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        }

        /**
         * 从本地文件导入一份人设内容。
         *
         * 浏览器读得到文件内容（读不到路径，这里也不需要）。导入只把文本放进输入框，
         * 落盘仍要点保存，用户还能在保存前先改几笔。
         *
         * @param event 文件输入框的 change 事件
         */
        async function importPersonaFile(event) {
          const file = event.target.files?.[0];
          // 先清空，同一个文件连选两次也要能触发 change。
          event.target.value = '';
          if (!file) return;
          setError('');
          if (file.size > MAX_PERSONA_BYTES) {
            setError(t('import.tooLarge'));
            return;
          }
          try {
            setPersona(await file.text());
            setNote('');
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        }

        React.useEffect(() => {
          void load(true);
          void loadSessions();
          const timer = setInterval(() => void load(false), POLL_MS);
          const sessionsTimer = setInterval(() => void loadSessions(), SESSIONS_POLL_MS);
          return () => {
            clearInterval(timer);
            clearInterval(sessionsTimer);
          };
        }, []);

        /**
         * 一个会话在下拉里的显示文案。
         *
         * @param session 宿主给的会话摘要
         * @returns 标题 · 短 ID · 打开状态 · 工作目录
         */
        function sessionLabel(session) {
          const state = session.live
            ? (session.running ? t('session.running') : t('session.live'))
            : t('session.notLive');
          return [
            session.title || t('session.untitled'),
            session.id.slice(0, 8),
            state,
            session.cwd,
          ].filter(Boolean).join(' · ');
        }

        /** 下拉选项；当前值不在列表里时补一项，避免保存时把已有配置悄悄清掉。 */
        function sessionOptions() {
          const options = [h('option', { key: '__empty', value: '' }, t('session.placeholder'))];
          const known = new Set();
          for (const session of sessions) {
            known.add(session.id);
            options.push(h('option', { key: session.id, value: session.id }, sessionLabel(session)));
          }
          if (sessionId && !known.has(sessionId)) {
            options.push(h('option', { key: '__current', value: sessionId },
              `${t('session.unknown')} ${sessionId}`));
          }
          return options;
        }

        async function save(event) {
          if (event) event.preventDefault();
          setSaving(true);
          setNote('');
          setError('');
          try {
            const configResponse = await fetch(CONFIG_ROUTE, {
              method: 'PUT',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId, persona }),
            });
            const configResult = await configResponse.json();
            if (!configResponse.ok) throw new Error(configResult?.error ?? `HTTP ${configResponse.status}`);

            // App Secret 留空表示不改动，避免每次保存都要重打一遍。
            const credentialsBody = {};
            if (appId.trim()) credentialsBody.appId = appId.trim();
            if (appSecret.trim()) credentialsBody.appSecret = appSecret.trim();
            if (Object.keys(credentialsBody).length > 0) {
              const credentialResponse = await fetch(CREDENTIALS_ROUTE, {
                method: 'PUT',
                credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(credentialsBody),
              });
              const credentialResult = await credentialResponse.json();
              if (!credentialResponse.ok) throw new Error(credentialResult?.error ?? `HTTP ${credentialResponse.status}`);
            }

            setAppId('');
            setAppSecret('');
            setNote(t('saved'));
            await load(false);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setSaving(false);
          }
        }

        const connectionText = snapshot === null
          ? '—'
          : t(snapshot.connected ? STATUS_KEY.connected : STATUS_KEY.disconnected);
        const configuredText = (flag) => (flag ? t('status.configured') : t('status.notConfigured'));
        const pairingCode = snapshot?.pairing ?? null;
        const pairingExpiry = pairingCode
          ? t('pairing.expiresIn').replace(
            '{minutes}',
            String(Math.max(1, Math.ceil((pairingCode.expiresAt - Date.now()) / 60000))),
          )
          : '';

        return h('section', { style: styles.section }, [
          h('div', { key: 'title', style: styles.heading }, t('heading')),
          h('p', { key: 'intro', style: styles.intro }, t('intro')),

          h('form', { key: 'form', onSubmit: save }, [
            h('div', { key: 'appId', style: styles.row }, [
              h(FieldLabel, {
                key: 'l',
                htmlFor: 'feishu-app-id',
                text: t('field.appId'),
                configured: snapshot?.appIdConfigured,
              }),
              h('div', { key: 'f', style: styles.field }, [
                h('input', {
                  key: 'i',
                  id: 'feishu-app-id',
                  style: styles.input,
                  type: 'text',
                  value: appId,
                  autoComplete: 'off',
                  placeholder: credentialPlaceholder(snapshot?.appIdConfigured, snapshot?.appIdWritable, t('placeholder.appId')),
                  onChange: (event) => setAppId(event.target.value),
                }),
              ]),
            ]),
            h('div', { key: 'appSecret', style: styles.row }, [
              h(FieldLabel, {
                key: 'l',
                htmlFor: 'feishu-app-secret',
                text: t('field.appSecret'),
                configured: snapshot?.appSecretConfigured,
              }),
              h('div', { key: 'f', style: styles.field }, [
                h('input', {
                  key: 'i',
                  id: 'feishu-app-secret',
                  style: styles.input,
                  type: 'password',
                  value: appSecret,
                  autoComplete: 'new-password',
                  placeholder: credentialPlaceholder(snapshot?.appSecretConfigured, snapshot?.appSecretWritable, t('placeholder.appSecret')),
                  onChange: (event) => setAppSecret(event.target.value),
                }),
                h('div', { key: 'h', style: styles.hint }, t('hint.appSecret')),
              ]),
            ]),
            h('div', { key: 'sessionId', style: styles.row }, [
              h(FieldLabel, {
                key: 'l',
                htmlFor: 'feishu-session-id',
                text: t('field.sessionId'),
                configured: sessionId ? true : undefined,
              }),
              h('div', { key: 'f', style: styles.field }, [
                h('select', {
                  key: 'i',
                  id: 'feishu-session-id',
                  style: styles.input,
                  value: sessionId,
                  onChange: (event) => setSessionId(event.target.value),
                }, sessionOptions()),
                h('div', { key: 'h', style: styles.hint }, t('hint.sessionId')),
              ]),
            ]),
            h('div', { key: 'persona', style: styles.row }, [
              h(FieldLabel, {
                key: 'l',
                htmlFor: 'feishu-persona',
                text: t('field.persona'),
                configured: snapshot?.personaActive,
              }),
              h('div', { key: 'f', style: styles.field }, [
                h('textarea', {
                  key: 'i',
                  id: 'feishu-persona',
                  style: styles.textarea,
                  value: persona,
                  spellCheck: false,
                  placeholder: t('placeholder.persona'),
                  onChange: (event) => setPersona(event.target.value),
                }),
                h('input', {
                  key: 'file',
                  ref: fileInput,
                  type: 'file',
                  accept: PERSONA_ACCEPT,
                  style: { display: 'none' },
                  onChange: (event) => void importPersonaFile(event),
                }),
                h('div', { key: 'r', style: styles.actions }, [
                  h('button', {
                    key: 'b',
                    type: 'button',
                    style: styles.secondary,
                    onClick: () => fileInput.current?.click(),
                  }, t('button.import')),
                ]),
                h('div', { key: 'h', style: styles.hint }, t('hint.persona')),
              ]),
            ]),
            h('div', { key: 'pairingTitle', style: styles.blockTitle }, t('pairing.title')),
            h('p', { key: 'pairingIntro', style: styles.hint }, t('pairing.intro')),
            pairingCode
              ? h('div', { key: 'pairingCode', style: styles.pairingBox }, [
                h('code', { key: 'c', style: styles.pairingCode }, pairingCode.code),
                h('span', { key: 'ttl', style: styles.hint }, pairingExpiry),
              ])
              : null,
            h('div', { key: 'pairingActions', style: styles.actions }, [
              h('button', {
                key: 'pair',
                type: 'button',
                style: styles.secondary,
                onClick: () => void startPairing(),
              }, pairingCode ? t('pairing.regenerate') : t('pairing.generate')),
            ]),
            h('div', { key: 'actions', style: styles.actions }, [
              h('button', { key: 'save', type: 'submit', style: styles.primary, disabled: saving },
                saving ? t('button.saving') : t('button.save')),
              h('button', {
                key: 'refresh',
                type: 'button',
                style: styles.secondary,
                onClick: () => {
                  void load(false);
                  void loadSessions();
                },
              }, t('button.refresh')),
              note ? h('span', { key: 'note', style: { ...styles.note, color: 'var(--dsw-alias-state-success-primary)' } }, note) : null,
            ]),
          ]),

          h('div', { key: 'statusTitle', style: styles.blockTitle }, t('status.title')),
          h(StatusRow, { key: 'connection', label: t('status.connection'), value: connectionText }),
          h(StatusRow, {
            key: 'appIdStatus',
            label: t('status.appId'),
            value: `${configuredText(snapshot?.appIdConfigured)}${snapshot?.appIdSource ? ` · ${t('status.source')}: ${snapshot.appIdSource}` : ''}`,
          }),
          h(StatusRow, {
            key: 'secretStatus',
            label: t('status.appSecret'),
            value: `${configuredText(snapshot?.appSecretConfigured)}${snapshot && snapshot.appSecretWritable === false ? ` · ${t('status.readOnly')}` : ''}`,
          }),
          h(StatusRow, {
            key: 'sessionStatus',
            label: t('status.sessionId'),
            value: snapshot?.sessionId
              ? `${snapshot.sessionId} · ${snapshot.sessionLive ? t('session.live') : t('session.notLive')}`
              : t('status.none'),
          }),
          snapshot?.sessionError
            ? h(StatusRow, {
              key: 'sessionErrorStatus',
              label: t('status.sessionError'),
              value: snapshot.sessionError,
              error: true,
            })
            : null,
          h(StatusRow, {
            key: 'personaModeStatus',
            label: t('status.personaMode'),
            value: snapshot?.personaActive
              ? t('status.personaActive').replace('{bytes}', String(snapshot?.personaBytes ?? 0))
              : t('status.personaInactive'),
          }),
          h(StatusRow, {
            key: 'managerStatus',
            label: t('status.managerId'),
            value: snapshot?.managerId || t('status.managerIdNone'),
          }),
          error ? h('div', { key: 'error', style: styles.error }, error) : null,
          snapshot?.lastError ? h('div', { key: 'lastError', style: styles.error }, `${t('status.lastError')}: ${snapshot.lastError}`) : null,
        ]);
      };
    }

    /**
     * 客户端插件入口。
     *
     * @param ctx 客户端 Cordis 上下文
     */
    function apply(ctx) {
      const slots = ctx.get('slots');
      if (slots === undefined) return;
      const locale = ctx.get('locale');

      if (locale !== undefined) {
        try {
          ctx.effect(() => {
            const disposes = [
              locale.register(LOCALE_NS, 'zh', MESSAGES.zh),
              locale.register(LOCALE_NS, 'en', MESSAGES.en),
            ];
            return () => {
              for (const dispose of disposes) dispose();
            };
          });
        } catch (error) {
          console.warn('feishu-assistant: locale registration failed', error);
        }
      }

      const t = locale !== undefined
        ? locale.bind(LOCALE_NS)
        : (key) => MESSAGES.zh[key] ?? key;

      const Section = createSection(t);

      // 语言切换后重渲染一次，分区标题用的是 thunk，外壳会重新读取。
      function LocaleAwareSection() {
        const [, bump] = React.useReducer((value) => value + 1, 0);
        React.useEffect(() => {
          if (locale === undefined) return undefined;
          return locale.subscribe(() => bump());
        }, []);
        return h(Section);
      }

      slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: 'feishu-assistant',
        order: 170,
        label: () => t('section'),
      }, LocaleAwareSection));
    }

    module.exports.apply = apply;
    module.exports.inject = ['slots'];
    return module.exports;
  },
});
