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
var RETRY_CLASSES = ["quota", "rate-limit", "auth", "network"];
var RETRY_HINT = {
  quota: "\u989D\u5EA6\u7528\u5C3D\uFF08402 / \u4F59\u989D\u4E0D\u8DB3\uFF09",
  "rate-limit": "\u9650\u6D41\uFF08429\uFF09",
  auth: "\u9274\u6743\u5931\u6548\uFF08401/403\uFF09",
  network: "\u7F51\u7EDC / \u4F9B\u5E94\u5546\u5B95\u673A\uFF085xx\uFF09"
};
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
var mutedTitle = { margin: "0 0 2px", fontSize: 13, fontWeight: 600, opacity: 0.75 };
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
function sameConfig(a, b) {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}
function normalize(c) {
  return {
    groups: (c.groups ?? []).map((g) => ({ id: g.id, entries: (g.entries ?? []).map((e) => ({ provider: e.provider, model: e.model })) })),
    activeGroup: c.activeGroup ?? "",
    cooldownMinutes: c.cooldownMinutes ?? 30,
    retryOn: [...c.retryOn ?? []].sort(),
    autoDiscover: c.autoDiscover ?? true
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
  const remote = props.remote;
  const reload = (0, import_react.useCallback)(async () => {
    if (remote === void 0) return;
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
    const ids = providerIds;
    const d = catalog?.default;
    const ordered = d?.provider !== void 0 && ids.includes(d.provider) ? [d.provider, ...ids.filter((id) => id !== d.provider)] : ids;
    return ordered.map((id) => ({
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
        autoMode ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { style: surface, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: row, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: dot(true) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { style: { ...sectionTitle, margin: 0 }, children: "\u81EA\u52A8\u66FF\u8865\u5DF2\u542F\u7528\uFF08\u9ED8\u8BA4\uFF09" })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: hint, children: [
            "\u5F53\u524D\u5DF2\u914D\u7F6E ",
            autoPreview.length,
            " \u4E2A provider\uFF0C\u6309\u6CE8\u518C\u987A\u5E8F\u4E92\u76F8\u66FF\u8865\uFF08\u9ED8\u8BA4\u6A21\u578B\u4F18\u5148\uFF09\uFF0C \u4EFB\u4E00\u8D26\u53F7\u989D\u5EA6\u7528\u5C3D\u81EA\u52A8\u5207\u5230\u4E0B\u4E00\u4E2A\u3002\u4E0B\u65B9\u4E3A\u5B9E\u65F6\u9884\u89C8\uFF1A"
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
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { style: { ...sectionTitle, margin: 0 }, children: "\u624B\u52A8\u66FF\u8865\u94FE" }),
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
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { style: sectionTitle, children: "\u5207\u6362\u7B56\u7565" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: row, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { display: "grid", gap: 4 }, children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { ...mutedTitle }, children: "\u51B7\u5374\uFF08\u5206\u949F\uFF09cooldown" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                import_dsh_client_ui_primitives3.Input,
                {
                  type: "number",
                  min: 1,
                  value: draft.cooldownMinutes ?? 30,
                  style: { width: 130 },
                  onChange: (e) => setDraftConfig({ ...draft, cooldownMinutes: Number(e.target.value) || 30 })
                }
              )
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "grid", gap: 4 }, children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: mutedTitle, children: "\u89E6\u53D1\u5207\u6362\u7684\u9519\u8BEF\u7C7B\u522B retry on" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: row, children: RETRY_CLASSES.map((klass) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                import_dsh_client_ui_primitives2.Checkbox,
                {
                  checked: (draft.retryOn ?? RETRY_CLASSES).includes(klass),
                  label: klass,
                  title: RETRY_HINT[klass],
                  onChange: (next) => {
                    const current = new Set(draft.retryOn ?? RETRY_CLASSES);
                    if (next) current.add(klass);
                    else current.delete(klass);
                    setDraftConfig({ ...draft, retryOn: [...current] });
                  }
                },
                klass
              )) })
            ] })
          ] })
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
var inject = ["slots", "remote", "remote.settings", "remote.session"];
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
