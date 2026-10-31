window.__ModuleLoader__.load({
  id: "dsh-model-failover",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.tsx
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
var import_dsh_client_ui_primitives2 = require("@deepseek-ai/dsh-client-ui-primitives");
var import_dsh_client_ui_primitives3 = require("@deepseek-ai/dsh-client-ui-primitives");
var import_dsh_client_ui_primitives4 = require("@deepseek-ai/dsh-client-ui-primitives");
var import_jsx_runtime = require("react/jsx-runtime");
var NS = "model-failover";
var surface = {
  background: "var(--dsw-alias-surface-secondary, rgba(127,127,127,0.04))",
  borderRadius: 14,
  padding: 16
};
var card = {
  background: "var(--dsw-alias-surface-primary, transparent)",
  border: "1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.22))",
  borderRadius: 12,
  padding: "12px 14px"
};
var row = { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" };
var sectionTitle = { margin: "0 0 10px", fontSize: 14, fontWeight: 600 };
var hint = { opacity: 0.55, fontSize: 12, margin: "6px 0 0", lineHeight: 1.6 };
var selectStyle = {
  padding: "6px 10px",
  borderRadius: 8,
  border: "1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.22))",
  background: "var(--dsw-alias-surface-primary, transparent)",
  color: "inherit"
};
var dot = (ok) => ({
  width: 7,
  height: 7,
  borderRadius: 999,
  flexShrink: 0,
  background: ok ? "var(--dsw-alias-text-success, #22a06b)" : "var(--dsw-alias-text-tertiary, #999)"
});
var providerCell = { display: "flex", alignItems: "center", gap: 7, minWidth: 210 };
var PI_AI_NS = "llm-pi-ai";
function deriveKeyRef(route) {
  return route.toUpperCase().replace(/[^A-Z0-9]+/g, "_") + "_API_KEY";
}
function sameConfig(a, b) {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}
function normalize(c) {
  return {
    groups: (c.groups ?? []).map((g) => ({ id: g.id, entries: (g.entries ?? []).map((e) => ({ provider: e.provider, model: e.model })) })),
    activeGroup: c.activeGroup ?? "",
    cooldownMinutes: c.cooldownMinutes ?? 30,
    retryOn: [...c.retryOn ?? []].sort(),
    autoDiscover: c.autoDiscover ?? true,
    // Host 写入的切换记录随保存原样透传，避免被覆盖丢失
    ...c.lastSwitches !== void 0 ? { lastSwitches: c.lastSwitches } : {}
  };
}
function invalidReasons(c) {
  const problems = [];
  for (const group of c.groups ?? []) {
    if ((group.id ?? "").trim() === "") problems.push("\u5B58\u5728\u672A\u547D\u540D\u7684\u5206\u7EC4");
    for (const [i, entry] of (group.entries ?? []).entries()) {
      if (entry.provider.trim() === "" || entry.model.trim() === "") {
        problems.push('\u5206\u7EC4 "' + group.id + '" \u7B2C ' + (i + 1) + " \u6761\u4E0D\u5B8C\u6574");
      }
    }
  }
  if ((c.cooldownMinutes ?? 30) < 1) problems.push("\u51B7\u5374\u65F6\u957F\u81F3\u5C11 1 \u5206\u949F");
  return problems;
}
function FailoverCard(props) {
  const [saved, setSaved] = (0, import_react.useState)(null);
  const [draft, setDraft] = (0, import_react.useState)(null);
  const [revision, setRevision] = (0, import_react.useState)(void 0);
  const [writable, setWritable] = (0, import_react.useState)(true);
  const [notice, setNotice] = (0, import_react.useState)(null);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [catalog, setCatalog] = (0, import_react.useState)(null);
  const [routes, setRoutes] = (0, import_react.useState)(null);
  const [piAiRevision, setPiAiRevision] = (0, import_react.useState)(void 0);
  const [credConfigured, setCredConfigured] = (0, import_react.useState)({});
  const [providerDir, setProviderDir] = (0, import_react.useState)(null);
  const [defaultModel, setDefaultModel] = (0, import_react.useState)(null);
  const [admRevision, setAdmRevision] = (0, import_react.useState)(void 0);
  const [dmProvider, setDmProvider] = (0, import_react.useState)("");
  const [dmModel, setDmModel] = (0, import_react.useState)("");
  const [dmBusy, setDmBusy] = (0, import_react.useState)(false);
  const remote = props.remote;
  const reload = (0, import_react.useCallback)(async () => {
    if (remote === void 0) return;
    if (remote.settings === void 0 || remote.session === void 0) {
      setNotice({ failed: true, text: "\u5F53\u524D DSH \u7248\u672C\u672A\u63D0\u4F9B settings/session \u670D\u52A1\uFF0C\u63D2\u4EF6\u5361\u7247\u4E0D\u53EF\u7528\uFF08\u4E0D\u5F71\u54CD\u5176\u4ED6\u529F\u80FD\uFF09" });
      return;
    }
    try {
      const response = await remote.settings.describe();
      if (response?.ok !== true) {
        setNotice({ failed: true, text: "\u8BFB\u53D6\u914D\u7F6E\u5931\u8D25\uFF1A" + (response?.error?.message ?? "") });
        return;
      }
      const view = response.value?.namespaces?.find((row2) => row2.ns === NS);
      if (view === void 0) {
        setNotice({ failed: true, text: "\u547D\u540D\u7A7A\u95F4\u672A\u5C31\u7EEA\uFF08\u63D2\u4EF6\u672A\u542F\u7528\uFF1F\uFF09/ namespace not served" });
        return;
      }
      setSaved(view.value ?? {});
      setDraft(view.value ?? {});
      setRevision(view.revision);
      setWritable(view.writable !== false);
      setNotice(null);
      const adm = response.value?.namespaces?.find((row2) => row2.ns === "agent-default-model");
      setDefaultModel(adm?.value ?? null);
      setAdmRevision(adm?.revision);
      setDmProvider(adm?.value?.provider ?? "");
      setDmModel(adm?.value?.model ?? "");
      const piAi = response.value?.namespaces?.find((row2) => row2.ns === PI_AI_NS);
      const providers = piAi?.value?.providers ?? {};
      setRoutes(providers);
      setPiAiRevision(piAi?.revision);
      const refs = Object.entries(providers).map(([route, profile]) => profile.apiKeyEnv ?? deriveKeyRef(route));
      if (remote.credentials !== void 0 && refs.length > 0) {
        try {
          const answer = await remote.credentials.describe(refs);
          if (answer?.ok === true && answer.value !== void 0) {
            const map = {};
            for (const [ref, v] of Object.entries(answer.value)) map[ref] = v !== void 0 && v !== null && v !== "";
            setCredConfigured(map);
          }
        } catch {
        }
      }
    } catch (error) {
      setNotice({ failed: true, text: String(error) });
    }
  }, [remote]);
  (0, import_react.useEffect)(() => {
    if (remote === void 0 || props.view === "summary") return;
    let alive = true;
    void (async () => {
      await reload();
      try {
        const response = await remote.session.modelCatalog();
        if (alive && response?.ok === true) setCatalog(response.value ?? null);
      } catch {
      }
      try {
        const response = await remote.llm?.listConfigurableProviders();
        if (alive && response?.ok === true) setProviderDir(response.value ?? []);
      } catch {
      }
    })();
    return () => {
      alive = false;
    };
  }, [remote, props.view, reload]);
  const dirty = (0, import_react.useMemo)(() => saved !== null && draft !== null && !sameConfig(saved, draft), [saved, draft]);
  const problems = (0, import_react.useMemo)(() => draft === null ? [] : invalidReasons(draft), [draft]);
  const shell = {
    available: saved !== null,
    writable,
    dirty,
    invalid: problems.length > 0,
    saving: busy,
    failed: notice?.failed === true
  };
  const catalogById = (0, import_react.useMemo)(() => new Map((catalog?.groups ?? []).map((g) => [g.id, g])), [catalog]);
  const routable = (0, import_react.useMemo)(() => new Set(catalog?.routableProviders ?? []), [catalog]);
  const providerIds = (0, import_react.useMemo)(() => (catalog?.groups ?? []).map((g) => g.id), [catalog]);
  const autoMode = (draft?.groups ?? []).length === 0 && draft?.autoDiscover !== false;
  const setDraftConfig = (next) => setDraft(next);
  const generateFromCatalog = () => {
    const entries = providerIds.map((id) => {
      const model = catalogById.get(id)?.models?.[0]?.id ?? "";
      return { provider: id, model };
    });
    setDraftConfig({ ...draft, groups: [{ id: "main", entries }] });
  };
  const autoPreview = (0, import_react.useMemo)(() => {
    const d = catalog?.default;
    return providerIds.map((id) => ({
      provider: id,
      name: catalogById.get(id)?.name ?? id,
      model: d?.provider === id && d?.model !== void 0 ? d.model : catalogById.get(id)?.models?.[0]?.id ?? ""
    }));
  }, [providerIds, catalog, catalogById]);
  const save = (0, import_react.useCallback)(async () => {
    if (remote === void 0 || draft === null) return;
    setBusy(true);
    try {
      const response = await remote.settings.update(NS, draft, revision);
      if (response?.ok !== true) {
        setNotice({ failed: true, text: "\u4FDD\u5B58\u5931\u8D25\uFF1A" + (response?.error?.message ?? "\u914D\u7F6E\u5DF2\u88AB\u5176\u4ED6\u7A97\u53E3\u4FEE\u6539\uFF0C\u8BF7\u5237\u65B0\u91CD\u8BD5") });
      } else {
        setSaved(draft);
        setNotice({ failed: false, text: "\u5DF2\u4FDD\u5B58\uFF0C\u914D\u7F6E\u5373\u65F6\u751F\u6548" });
        void reload();
      }
    } catch (error) {
      setNotice({ failed: true, text: String(error) });
    } finally {
      setBusy(false);
    }
  }, [remote, draft, revision, reload]);
  const [acctBusy, setAcctBusy] = (0, import_react.useState)(false);
  const [copyOf, setCopyOf] = (0, import_react.useState)("");
  const [copyKey, setCopyKey] = (0, import_react.useState)("");
  const [editOf, setEditOf] = (0, import_react.useState)("");
  const [editKey, setEditKey] = (0, import_react.useState)("");
  const isCloneOf = (route, baseId) => route.startsWith(baseId + "-") && /^\d+$/.test(route.slice(baseId.length + 1));
  const copyProvider = async (baseId) => {
    if (remote === void 0 || draft === null || routes === null) return;
    const base = routes[baseId];
    if (base === void 0 || copyKey.trim() === "") return;
    let n = 2;
    while (routes[baseId + "-" + n] !== void 0) n += 1;
    const route = baseId + "-" + n;
    setAcctBusy(true);
    try {
      const keyRef = deriveKeyRef(route);
      const dirEntry = providerDir?.find((row2) => row2.provider === baseId);
      const baseURL = String(base.baseURL ?? dirEntry?.defaultBaseURL ?? "");
      if (baseURL === "") {
        setNotice({ failed: true, text: "\u65E0\u6CD5\u786E\u5B9A " + baseId + " \u7684 baseURL\uFF0C\u8BF7\u5148\u5728 \u8BBE\u7F6E\u2192\u6A21\u578B \u4E3A\u5B83\u5B8C\u6210\u4E00\u6B21\u914D\u7F6E" });
        return;
      }
      let models = base.models ?? [];
      if (models.length === 0) {
        const discovered = await remote.llm?.discoverModels(PI_AI_NS, { provider: baseId });
        if (discovered?.ok !== true || (discovered.value ?? []).length === 0) {
          setNotice({ failed: true, text: "\u83B7\u53D6 " + baseId + " \u7684\u6A21\u578B\u5217\u8868\u5931\u8D25\uFF1A" + (discovered?.error?.message ?? "\u8BF7\u5148\u5728 \u8BBE\u7F6E\u2192\u6A21\u578B \u4E3A\u5B83\u5B8C\u6210\u4E00\u6B21\u914D\u7F6E") });
          return;
        }
        models = (discovered.value ?? []).map((m) => ({
          id: m.id,
          ...m.name === void 0 ? {} : { name: m.name },
          ...m.contextWindow === void 0 ? {} : { contextWindow: m.contextWindow },
          ...m.maxTokens === void 0 ? {} : { maxTokens: m.maxTokens },
          ...m.inputModalities === void 0 ? {} : { input: [...m.inputModalities] }
        }));
      }
      const guessApi = () => {
        if (base.api !== void 0) return String(base.api);
        const s = (baseId + " " + baseURL).toLowerCase();
        return s.includes("anthropic") || s.includes("claude") ? "anthropic-messages" : "openai-completions";
      };
      const profile = { apiKeyEnv: keyRef, api: guessApi(), baseURL, models: models.map((m) => ({ ...m })) };
      const written = await remote.settings.mutate(PI_AI_NS, [{ op: "set", path: ["providers", route], value: profile }], piAiRevision);
      if (written?.ok !== true) {
        setNotice({ failed: true, text: "\u5199\u5165\u4F9B\u5E94\u5546\u914D\u7F6E\u5931\u8D25\uFF1A" + (written?.error?.message ?? "") });
        return;
      }
      if (remote.credentials !== void 0) {
        const stored = await remote.credentials.set(keyRef, copyKey.trim());
        if (stored?.ok !== true) {
          setNotice({ failed: true, text: "\u8DEF\u7531\u5DF2\u521B\u5EFA\uFF0C\u4F46 Key \u5B58\u50A8\u5931\u8D25\uFF1A" + (stored?.error?.message ?? "") });
          return;
        }
      }
      let next = draft;
      if ((draft.groups ?? []).length > 0) {
        next = {
          ...draft,
          groups: (draft.groups ?? []).map((g) => {
            const entries = (g.entries ?? []).map((x) => ({ provider: x.provider, model: x.model }));
            let last = -1;
            for (let i = 0; i < entries.length; i++) {
              if (entries[i].provider === baseId || isCloneOf(entries[i].provider, baseId)) last = i;
            }
            if (last === -1) return { id: g.id, entries };
            entries.splice(last + 1, 0, { provider: route, model: entries[last].model });
            return { id: g.id, entries };
          })
        };
        const savedChain = await remote.settings.update(NS, next, revision);
        if (savedChain?.ok !== true) setNotice({ failed: true, text: "\u8D26\u53F7\u5DF2\u521B\u5EFA\uFF0C\u4F46\u63D2\u5165\u66FF\u8865\u94FE\u5931\u8D25\uFF1A" + (savedChain?.error?.message ?? "") });
        else {
          setDraft(next);
          setSaved(next);
        }
      }
      if (notice?.failed !== true) setNotice({ failed: false, text: "\u5DF2\u590D\u5236 " + baseId + " \u2192 " + route + "\uFF0CKey \u5DF2\u52A0\u5BC6\u5B58\u50A8" });
      setCopyOf("");
      setCopyKey("");
      void reload();
    } catch (error) {
      setNotice({ failed: true, text: String(error) });
    } finally {
      setAcctBusy(false);
    }
  };
  const rekeyRoute = async (route) => {
    if (remote === void 0 || remote.credentials === void 0 || editKey.trim() === "") return;
    setAcctBusy(true);
    try {
      const ref = routes?.[route]?.apiKeyEnv ?? deriveKeyRef(route);
      const r = await remote.credentials.set(ref, editKey.trim());
      if (r?.ok === true) {
        setNotice({ failed: false, text: route + " \u7684 Key \u5DF2\u66F4\u65B0" });
        setEditOf("");
        setEditKey("");
        void reload();
      } else setNotice({ failed: true, text: "Key \u5199\u5165\u5931\u8D25\uFF1A" + (r?.error?.message ?? "") });
    } catch (error) {
      setNotice({ failed: true, text: String(error) });
    } finally {
      setAcctBusy(false);
    }
  };
  const removeAccount = async (route) => {
    if (remote === void 0 || draft === null || routes === null) return;
    if (!window.confirm("\u5220\u9664\u8D26\u53F7 " + route + "\uFF1F\u5C06\u540C\u65F6\u79FB\u9664\u5176\u914D\u7F6E\u3001\u51ED\u636E\u4E0E\u66FF\u8865\u94FE\u6761\u76EE\u3002")) return;
    setAcctBusy(true);
    try {
      const profile = routes[route];
      const ref = profile?.apiKeyEnv ?? deriveKeyRef(route);
      const removed = await remote.settings.mutate(PI_AI_NS, [{ op: "unset", path: ["providers", route] }], piAiRevision);
      if (removed?.ok !== true) {
        setNotice({ failed: true, text: "\u5220\u9664\u8DEF\u7531\u5931\u8D25\uFF1A" + (removed?.error?.message ?? "") });
        return;
      }
      if (remote.credentials !== void 0) {
        try {
          await remote.credentials.unset(ref);
        } catch {
        }
      }
      const next = { ...draft, groups: (draft.groups ?? []).map((g) => ({ id: g.id, entries: (g.entries ?? []).filter((x) => x.provider !== route).map((x) => ({ provider: x.provider, model: x.model })) })) };
      const savedChain = await remote.settings.update(NS, next, revision);
      if (savedChain?.ok !== true) setNotice({ failed: true, text: "\u8DEF\u7531\u5DF2\u5220\u9664\uFF0C\u4F46\u66F4\u65B0\u66FF\u8865\u94FE\u5931\u8D25\uFF1A" + (savedChain?.error?.message ?? "") });
      else {
        setNotice({ failed: false, text: "\u8D26\u53F7 " + route + " \u5DF2\u5220\u9664" });
        setDraft(next);
        setSaved(next);
      }
      void reload();
    } catch (error) {
      setNotice({ failed: true, text: String(error) });
    } finally {
      setAcctBusy(false);
    }
  };
  const saveDefaultModel = async () => {
    if (remote === void 0 || dmProvider === "" || dmModel === "") return;
    setDmBusy(true);
    try {
      const w = await remote.settings.mutate("agent-default-model", [
        { op: "set", path: ["provider"], value: dmProvider },
        { op: "set", path: ["model"], value: dmModel }
      ], admRevision);
      if (w?.ok !== true) {
        setNotice({ failed: true, text: "\u5207\u6362\u9ED8\u8BA4\u6A21\u578B\u5931\u8D25\uFF1A" + (w?.error?.message ?? "") });
        return;
      }
      setNotice({ failed: false, text: "\u9ED8\u8BA4\u6A21\u578B\u5DF2\u5207\u6362\u4E3A " + dmProvider + " / " + dmModel });
      void reload();
    } catch (error) {
      setNotice({ failed: true, text: String(error) });
    } finally {
      setDmBusy(false);
    }
  };
  if (props.view === "summary") {
    return "\u591A\u4F9B\u5E94\u5546 / \u591A\u8D26\u53F7\u6A21\u578B\u81EA\u52A8\u66FF\u8865\uFF1A\u989D\u5EA6\u7528\u5B8C\u81EA\u52A8\u6309\u66FF\u8865\u987A\u5E8F\u5207\u6362\u4E0B\u4E00\u68D2\uFF0C\u4EFB\u52A1\u4E0D\u4E2D\u65AD\uFF08Model & account failover\uFF09";
  }
  if (saved === null || draft === null) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: hint, children: notice?.text ?? "\u52A0\u8F7D\u4E2D\u2026 / loading\u2026" });
  }
  const groups = draft.groups ?? [];
  const activeId = draft.activeGroup || groups[0]?.id || "";
  const patchGroup = (index, patch) => {
    if (draft === null) return;
    setDraftConfig({ ...draft, groups: (draft.groups ?? []).map((g, i) => i === index ? { ...g, ...patch } : g) });
  };
  const moveEntry = (gi, ei, delta) => {
    const group = groups[gi];
    const entries = [...group?.entries ?? []];
    const target = ei + delta;
    if (group === void 0 || target < 0 || target >= entries.length) return;
    [entries[ei], entries[target]] = [entries[target], entries[ei]];
    patchGroup(gi, { entries });
  };
  const duplicateEntry = (gi, ei) => {
    const group = groups[gi];
    const entries = [...group?.entries ?? []];
    if (group === void 0) return;
    const source = entries[ei];
    if (source === void 0) return;
    let n = 2;
    const base = source.provider.replace(/-\d+$/, "");
    while (entries.some((e) => e.provider === base + "-" + n)) n += 1;
    entries.splice(ei + 1, 0, { provider: base + "-" + n, model: source.model });
    patchGroup(gi, { entries });
  };
  const modelOptions = (provider) => catalogById.get(provider)?.models ?? [];
  const entryRow = (group, gi) => (entry, ei) => {
    const options = modelOptions(entry.provider);
    const routableEntry = routable.has(entry.provider) || !catalogById.has(entry.provider);
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { style: { ...row, padding: "6px 0", borderBottom: "1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.12))" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { opacity: 0.5, fontSize: 12, width: 26, textAlign: "right" }, children: ei + 1 }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: providerCell, title: "\u53EF\u8DEF\u7531 routable: " + String(routableEntry), children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: dot(routableEntry) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          import_dsh_client_ui_primitives3.Input,
          {
            value: entry.provider,
            placeholder: "provider\uFF08\u8D26\u53F7\uFF09",
            list: "mf-provs-" + gi + "-" + ei,
            style: { width: 200 },
            onChange: (e) => patchGroup(gi, { entries: (group.entries ?? []).map((x, i) => i === ei ? { ...x, provider: e.target.value } : x) })
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("datalist", { id: "mf-provs-" + gi + "-" + ei, children: providerIds.map((id) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: id }, id)) }),
      options.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
        "select",
        {
          value: entry.model,
          style: selectStyle,
          onChange: (e) => patchGroup(gi, { entries: (group.entries ?? []).map((x, i) => i === ei ? { ...x, model: e.target.value } : x) }),
          children: [
            !options.some((m) => m.id === entry.model) ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: entry.model, children: entry.model }) : null,
            options.map((m) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: m.id, children: m.name !== void 0 && m.name !== m.id ? m.name + " \xB7 " + m.id : m.id }, m.id))
          ]
        }
      ) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        import_dsh_client_ui_primitives3.Input,
        {
          value: entry.model,
          placeholder: "model",
          style: { width: 180 },
          onChange: (e) => patchGroup(gi, { entries: (group.entries ?? []).map((x, i) => i === ei ? { ...x, model: e.target.value } : x) })
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", disabled: ei === 0, onClick: () => moveEntry(gi, ei, -1), title: "\u4E0A\u79FB\uFF08\u4F18\u5148\u7EA7\u66F4\u9AD8\uFF09", children: "\u2191" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", disabled: ei === (group.entries?.length ?? 1) - 1, onClick: () => moveEntry(gi, ei, 1), title: "\u4E0B\u79FB", children: "\u2193" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", onClick: () => duplicateEntry(gi, ei), title: "\u590D\u5236\u4E3A\u6B64\u8D26\u53F7\u7684\u66FF\u8865\uFF08\u591A Key \u591A\u8D26\u53F7\uFF09", children: "\u590D\u5236\u8D26\u53F7" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", onClick: () => patchGroup(gi, { entries: (group.entries ?? []).filter((_, i) => i !== ei) }), title: "\u5220\u9664", children: "\u2715" })
    ] }, ei);
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    import_dsh_client_ui_primitives4.SettingsForm,
    {
      labels: {
        unavailable: "\u547D\u540D\u7A7A\u95F4\u672A\u5C31\u7EEA\uFF08\u63D2\u4EF6\u672A\u542F\u7528\uFF09/ namespace not served",
        readOnly: "\u5F53\u524D\u90E8\u7F72\u7684\u914D\u7F6E\u4E3A\u53EA\u8BFB / read-only",
        saveFailed: notice?.failed === true ? notice.text : "",
        save: "\u4FDD\u5B58 / Save",
        saving: "\u4FDD\u5B58\u4E2D\u2026"
      },
      state: shell,
      onSave: () => {
        void save();
      },
      onDiscard: () => {
        if (saved !== null) {
          setDraft(saved);
          setNotice(null);
        }
      },
      children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "grid", gap: 18 }, children: [
        (saved.lastSwitches ?? []).length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { style: { ...card, borderColor: "var(--dsw-alias-state-warn-stroke, rgba(200,140,40,0.4))" }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: row, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { title: "\u5207\u6362\u63D0\u793A", children: "\u{1F501}" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { style: { fontSize: 13 }, children: "\u6700\u8FD1\u5207\u6362" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { flex: 1 } })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { style: { listStyle: "none", margin: "6px 0 0", padding: 0, display: "grid", gap: 4 }, children: (saved.lastSwitches ?? []).slice(-3).reverse().map((s, i) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { style: { ...row, fontSize: 12 }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { opacity: 0.75 }, children: s.from }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "\u2192" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { style: { color: "var(--dsw-alias-state-warn-label, #b8860b)" }, children: s.to }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { opacity: 0.55 }, children: [
              "\uFF08",
              s.reason,
              s.via === "fallback" ? " \xB7 \u76EE\u5F55\u515C\u5E95" : s.via === "second-chance" ? " \xB7 \u5145\u503C\u63A2\u6D4B" : "",
              "\uFF09"
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { opacity: 0.5 }, children: new Date(s.at).toLocaleString("zh-CN", { hour12: false }) })
          ] }, i)) })
        ] }) : null,
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { style: surface, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { style: sectionTitle, children: "\u6A21\u578B" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: card, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: row, children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: dot(defaultModel?.provider !== void 0 && defaultModel.provider !== "") }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                "select",
                {
                  value: dmProvider,
                  style: selectStyle,
                  onChange: (e) => {
                    setDmProvider(e.target.value);
                    setDmModel(catalogById.get(e.target.value)?.models?.[0]?.id ?? "");
                  },
                  children: providerIds.map((id) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: id, children: catalogById.get(id)?.name ?? id }, id))
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("select", { value: dmModel, style: selectStyle, onChange: (e) => setDmModel(e.target.value), children: (catalogById.get(dmProvider)?.models ?? []).map((m) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: m.id, children: m.name !== void 0 && m.name !== m.id ? m.name + " \xB7 " + m.id : m.id }, m.id)) }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                import_dsh_client_ui_primitives.Button,
                {
                  variant: "outline",
                  disabled: dmBusy || dmProvider === "" || dmModel === "" || dmProvider === defaultModel?.provider && dmModel === defaultModel?.model,
                  onClick: () => void saveDefaultModel(),
                  children: "\u5207\u6362"
                }
              )
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: hint, children: [
              "\u5F53\u524D\u9ED8\u8BA4\u6A21\u578B\uFF0C\u53EF\u5728\u6B64\u76F4\u63A5\u5207\u6362\u3002\u4EFB\u4E00\u8D26\u53F7\u5931\u8D25/\u989D\u5EA6\u7528\u5C3D\u65F6\uFF0C\u6BEB\u79D2\u7EA7\u7ACB\u5373\u5207\u6362\u5230\u987A\u5E8F\u4E2D\u7684\u4E0B\u4E00\u4E2A\u5065\u5EB7\u8D26\u53F7\uFF0C\u4EFB\u52A1\u4E0D\u4E2D\u65AD\uFF1B\u6545\u969C\u8D26\u53F7\u51B7\u5374 ",
              draft.cooldownMinutes ?? 30,
              " \u5206\u949F\u540E\u81EA\u52A8\u5F52\u961F\u3002"
            ] })
          ] })
        ] }),
        autoMode ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { style: surface, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: row, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: dot(true) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { style: { ...sectionTitle, margin: 0 }, children: "\u5207\u6362\u987A\u5E8F \xB7 \u81EA\u52A8\u66FF\u8865\uFF08\u9ED8\u8BA4\uFF09" })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: hint, children: [
            "\u5F53\u524D\u5DF2\u914D\u7F6E ",
            autoPreview.length,
            " \u4E2A provider\uFF0C\u6309\u6CE8\u518C\u987A\u5E8F\u4E92\u76F8\u66FF\u8865\uFF0C \u4EFB\u4E00\u8D26\u53F7\u989D\u5EA6\u7528\u5C3D\u81EA\u52A8\u5207\u5230\u4E0B\u4E00\u4E2A\u3002\u4E0B\u65B9\u4E3A\u5B9E\u65F6\u9884\u89C8\uFF1A"
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ol", { style: { margin: "8px 0 0", paddingLeft: 18 }, children: autoPreview.map((rowItem, i) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { style: { ...row, padding: "3px 0" }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { opacity: 0.5, fontSize: 12, width: 22, textAlign: "right" }, children: i + 1 }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: providerCell, children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: dot(routable.has(rowItem.provider)) }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { style: { fontWeight: 600 }, children: rowItem.name }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { opacity: 0.5, fontSize: 12 }, children: rowItem.provider })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { opacity: 0.7, fontSize: 12 }, children: rowItem.model })
          ] }, rowItem.provider)) }),
          catalog === null ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: hint, children: "\u6A21\u578B\u76EE\u5F55\u52A0\u8F7D\u4E2D\uFF08\u6216\u4E0D\u53EF\u7528\uFF09\uFF0C\u81EA\u52A8\u94FE\u5C06\u5728\u76EE\u5F55\u5C31\u7EEA\u540E\u751F\u6548\u3002" }) : null,
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: hint, children: '\u8981\u81EA\u5B9A\u4E49\u987A\u5E8F\u6216\u8D26\u53F7\uFF0C\u70B9\u51FB\u4E0B\u65B9"\u8F6C\u4E3A\u624B\u52A8\u914D\u7F6E"\uFF1B\u6E05\u7A7A\u5168\u90E8\u5206\u7EC4\u5373\u53EF\u56DE\u5230\u81EA\u52A8\u6A21\u5F0F\u3002' })
        ] }) : null,
        autoMode ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", onClick: generateFromCatalog, children: "\u8F6C\u4E3A\u624B\u52A8\u914D\u7F6E\uFF08\u4ECE\u5DF2\u914D\u7F6E\u6A21\u578B\u751F\u6210\u66FF\u8865\u94FE\uFF09" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { style: surface, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: row, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { style: { ...sectionTitle, margin: 0 }, children: "\u5207\u6362\u987A\u5E8F \xB7 \u624B\u52A8\u66FF\u8865\u94FE" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", onClick: () => setDraftConfig({ ...draft, groups: [] }), children: "\u6E05\u7A7A\uFF0C\u56DE\u5230\u81EA\u52A8\u6A21\u5F0F" })
          ] }),
          groups.map((group, gi) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...card, marginBottom: 10, opacity: autoMode ? 1 : group.id === draft.activeGroup || groups.length === 1 ? 1 : 0.75 }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: row, children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                import_dsh_client_ui_primitives3.Input,
                {
                  value: group.id,
                  placeholder: "group id",
                  style: { width: 160 },
                  onChange: (e) => patchGroup(gi, { id: e.target.value })
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                import_dsh_client_ui_primitives2.Checkbox,
                {
                  checked: group.id === draft.activeGroup,
                  label: "\u6FC0\u6D3B active",
                  onChange: () => setDraftConfig({ ...draft, activeGroup: group.id })
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", onClick: () => setDraftConfig({ ...draft, groups: groups.filter((_, i) => i !== gi) }), children: "\u5220\u9664\u7EC4" })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { marginTop: 8 }, children: (group.entries ?? []).map(entryRow(group, gi)) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...row, marginTop: 8 }, children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
                "select",
                {
                  defaultValue: "",
                  style: selectStyle,
                  onChange: (e) => {
                    const provider = e.target.value;
                    if (provider === "") return;
                    const model = catalogById.get(provider)?.models?.[0]?.id ?? "";
                    patchGroup(gi, { entries: [...group.entries ?? [], { provider, model }] });
                    e.target.value = "";
                  },
                  children: [
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "", disabled: true, children: "\uFF0B \u4ECE\u5DF2\u914D\u7F6E\u7684\u6A21\u578B\u6DFB\u52A0\u2026" }),
                    providerIds.map((id) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: id, children: catalogById.get(id)?.name ?? id }, id))
                  ]
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", onClick: () => patchGroup(gi, { entries: [...group.entries ?? [], { provider: "", model: "" }] }), children: "\uFF0B \u624B\u52A8\u6DFB\u52A0" })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: hint, children: "\u591A Key\uFF1A\u590D\u5236\u8D26\u53F7\uFF08\u6216 Models \u9875\u65B0\u5EFA\u540C\u540D\u81EA\u5B9A\u4E49 provider\uFF09\u540E\u5404\u914D\u4E00\u4E2A Key\uFF0C\u63D2\u4EF6\u6309\u987A\u5E8F\u81EA\u52A8\u5207\u6362\u3002" })
          ] }, gi)),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", onClick: () => setDraftConfig({ ...draft, groups: [...groups, { id: "group-" + (groups.length + 1), entries: [] }] }), children: "\uFF0B \u6DFB\u52A0\u5206\u7EC4 add group" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { style: surface, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { style: sectionTitle, children: "\u8D26\u53F7\uFF08\u591A Key\uFF09" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: hint, children: "\u81EA\u52A8\u8BC6\u522B\u7CFB\u7EDF\u5DF2\u914D\u7F6E\u7684\u4F9B\u5E94\u5546\u3002\u70B9\u300C\u590D\u5236\u300D\u53EA\u9700\u586B\u4E00\u628A\u65B0 Key\uFF0C\u5373\u53EF\u4E3A\u540C\u4E00\u4F9B\u5E94\u5546\u52A0\u4E00\u4E2A\u8D26\u53F7\uFF08\u5982 GLM \xD7 3\uFF09\uFF1B\u989D\u5EA6\u7528\u5C3D\u81EA\u52A8\u5207\u5230\u4E0B\u4E00\u4E2A\uFF0C\u5176\u4F59\u914D\u7F6E\u96F6\u91CD\u590D\u3002" }),
          catalog === null || routes === null ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: hint, children: "\u6B63\u5728\u8BFB\u53D6\u7CFB\u7EDF\u6A21\u578B\u914D\u7F6E\u2026" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { style: { listStyle: "none", margin: "10px 0 0", padding: 0, display: "grid", gap: 8 }, children: providerIds.filter((id) => !providerIds.some((other) => other !== id && isCloneOf(id, other))).map((baseId) => {
            const info = catalogById.get(baseId);
            const baseProfile = routes[baseId];
            const clones = Object.keys(routes).filter((r) => isCloneOf(r, baseId)).sort();
            const ref = baseProfile?.apiKeyEnv ?? deriveKeyRef(baseId);
            const copying = copyOf === baseId;
            return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { style: card, children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: row, children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: dot(credConfigured[ref] === true), title: credConfigured[ref] === true ? "Key \u5DF2\u914D\u7F6E" : "Key \u672A\u914D\u7F6E" }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: info?.name ?? baseId }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { opacity: 0.5, fontSize: 12 }, children: baseId }),
                clones.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { opacity: 0.6, fontSize: 12 }, children: [
                  "\u5DF2\u52A0 ",
                  clones.length,
                  " \u4E2A\u8D26\u53F7"
                ] }) : null,
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
                copying ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives3.Input, { type: "password", placeholder: "\u65B0\u8D26\u53F7\u7684 API Key", style: { width: 240 }, value: copyKey, onChange: (e) => setCopyKey(e.target.value) }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", disabled: acctBusy || copyKey.trim() === "", onClick: () => void copyProvider(baseId), children: "\u4FDD\u5B58" }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", onClick: () => {
                    setCopyOf("");
                    setCopyKey("");
                  }, children: "\u53D6\u6D88" })
                ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", disabled: baseProfile === void 0 || acctBusy, title: baseProfile === void 0 ? "\u8BE5\u4F9B\u5E94\u5546\u5C1A\u672A\u914D\u7F6E\uFF0C\u8BF7\u5148\u5728 \u8BBE\u7F6E\u2192\u6A21\u578B \u5B8C\u6210\u4E00\u6B21\u914D\u7F6E" : "\u590D\u5236\u6B64\u4F9B\u5E94\u5546\uFF0C\u4E3A\u65B0\u8D26\u53F7\u586B\u4E00\u628A\u65B0 Key", onClick: () => {
                  setCopyOf(baseId);
                  setCopyKey("");
                }, children: "\u590D\u5236" })
              ] }),
              clones.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { style: { listStyle: "none", margin: "8px 0 0", padding: 0, display: "grid", gap: 4 }, children: clones.map((route) => {
                const cref = routes[route]?.apiKeyEnv ?? deriveKeyRef(route);
                const cok = credConfigured[cref] === true;
                const editing = editOf === route;
                return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { style: { ...row, paddingLeft: 4 }, children: [
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: dot(cok), title: cok ? "Key \u5DF2\u914D\u7F6E" : "Key \u672A\u914D\u7F6E" }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontSize: 13, minWidth: 110 }, children: route }),
                  (() => {
                    const opts = (routes[route]?.models ?? []).map((m) => m.id);
                    let chained;
                    for (const g of draft.groups ?? []) {
                      const hit = (g.entries ?? []).find((x) => x.provider === route);
                      if (hit !== void 0) {
                        chained = hit.model;
                        break;
                      }
                    }
                    const current = chained ?? opts[0] ?? "";
                    const options = opts.includes(current) ? opts : [current, ...opts];
                    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                      "select",
                      {
                        value: current,
                        title: chained === void 0 ? "\u8BE5\u8D26\u53F7\u4E0D\u5728\u66FF\u8865\u94FE\u4E2D" : "\u6B64\u8D26\u53F7\u5728\u66FF\u8865\u94FE\u4E2D\u4F7F\u7528\u7684\u6A21\u578B\uFF08\u4FEE\u6539\u540E\u9700\u4FDD\u5B58\uFF09",
                        style: { ...selectStyle, fontSize: 12, flex: 1, maxWidth: 200 },
                        onChange: (e) => {
                          const model = e.target.value;
                          const groups2 = (draft.groups ?? []).map((g) => ({
                            id: g.id,
                            entries: (g.entries ?? []).map((x) => x.provider === route ? { provider: x.provider, model } : x)
                          }));
                          const touched = groups2.some((g) => (g.entries ?? []).some((x) => x.provider === route));
                          if (!touched) {
                            setNotice({ failed: true, text: route + " \u4E0D\u5728\u66FF\u8865\u94FE\u4E2D\uFF0C\u8BF7\u5148\u590D\u5236\u6216\u624B\u52A8\u52A0\u5165" });
                            return;
                          }
                          setDraftConfig({ ...draft, groups: groups2 });
                        },
                        children: options.map((id) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: id, children: id }, id))
                      }
                    );
                  })(),
                  editing ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives3.Input, { type: "password", placeholder: "\u65B0\u7684 API Key", style: { width: 200 }, value: editKey, onChange: (e) => setEditKey(e.target.value) }),
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", disabled: acctBusy || editKey.trim() === "", onClick: () => void rekeyRoute(route), children: "\u4FDD\u5B58" }),
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", onClick: () => {
                      setEditOf("");
                      setEditKey("");
                    }, children: "\u53D6\u6D88" })
                  ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", disabled: !cok || remote.credentials === void 0, onClick: () => {
                      setEditOf(route);
                      setEditKey("");
                    }, children: "\u6362 Key" }),
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", disabled: acctBusy, onClick: () => void removeAccount(route), children: "\u5220\u9664" })
                  ] })
                ] }, route);
              }) }) : null
            ] }, baseId);
          }) })
        ] }),
        problems.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: { ...hint, color: "var(--dsw-alias-text-danger, #c33)" }, children: [
          "\u26A0 ",
          problems.join("\uFF1B")
        ] }) : null,
        notice !== null && !notice.failed ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: hint, children: notice.text }) : null
      ] })
    }
  );
}
var inject = ["slots", "remote", "remote.settings", "remote.session", "remote.llm", "remote.credentials"];
function apply(ctx) {
  const register = () => ctx.slots.inject("plugins.item", () => ctx.slots.register({
    name: "plugins.item",
    id: "model-failover",
    order: 40,
    label: () => "Model Failover \u6A21\u578B\u66FF\u8865"
  }, (props) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(FailoverCard, { ...props, remote: ctx.remote })));
  if (ctx.effect !== void 0) ctx.effect(register, "model-failover: plugins card");
  else register();
}
    return module.exports;
  }
});
