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
var row = { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" };
var sectionTitle = { margin: "2px 0 8px", fontSize: 13, fontWeight: 600, opacity: 0.85 };
var hint = { opacity: 0.6, fontSize: 12, margin: "4px 0 0" };
var card = { border: "1px solid var(--dsw-alias-border-subtle, #8884)", borderRadius: 10, padding: 12, marginBottom: 10 };
function sameConfig(a, b) {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}
function normalize(c) {
  return {
    groups: (c.groups ?? []).map((g) => ({ id: g.id, entries: (g.entries ?? []).map((e) => ({ provider: e.provider, model: e.model })) })),
    activeGroup: c.activeGroup ?? "",
    cooldownMinutes: c.cooldownMinutes ?? 30,
    retryOn: [...c.retryOn ?? []].sort()
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
  const providerIds = (0, import_react.useMemo)(() => (catalog?.groups ?? []).map((g) => g.id), [catalog]);
  const activeId = draft?.activeGroup || draft?.groups?.[0]?.id || "";
  const setDraftConfig = (next) => setDraft(next);
  const patchGroup = (index, patch) => {
    if (draft === null) return;
    setDraftConfig({ ...draft, groups: (draft.groups ?? []).map((g, i) => i === index ? { ...g, ...patch } : g) });
  };
  const moveEntry = (gi, ei, delta) => {
    const group = draft?.groups?.[gi];
    const entries = [...group?.entries ?? []];
    const target = ei + delta;
    if (group === void 0 || target < 0 || target >= entries.length) return;
    [entries[ei], entries[target]] = [entries[target], entries[ei]];
    patchGroup(gi, { entries });
  };
  const duplicateEntry = (gi, ei) => {
    const group = draft?.groups?.[gi];
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
  const catalogPicker = (gi) => {
    if (providerIds.length === 0) return null;
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...row, marginTop: 6 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
        "select",
        {
          defaultValue: "",
          style: { padding: "4px 8px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-subtle, #8884)", background: "transparent", color: "inherit" },
          onChange: (e) => {
            const provider = e.target.value;
            if (provider === "") return;
            const group = catalogById.get(provider);
            const model = group?.models?.[0]?.id ?? "";
            patchGroup(gi, { entries: [...draft?.groups?.[gi]?.entries ?? [], { provider, model }] });
            e.target.value = "";
          },
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "", disabled: true, children: "\uFF0B \u4ECE\u5DF2\u914D\u7F6E\u7684\u6A21\u578B\u6DFB\u52A0\u2026" }),
            providerIds.map((id) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: id, children: catalogById.get(id)?.name ?? id }, id))
          ]
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: hint, children: "\u9009\u62E9\u540E\u81EA\u52A8\u586B\u5165\u8BE5 provider \u7684\u7B2C\u4E00\u4E2A\u6A21\u578B\uFF0C\u53EF\u518D\u4FEE\u6539" })
    ] });
  };
  const modelOptions = (provider) => catalogById.get(provider)?.models ?? [];
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
      children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "grid", gap: 14 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { style: sectionTitle, children: "\u66FF\u8865\u94FE Fallback groups \u2014\u2014 \u6570\u7EC4\u987A\u5E8F\u5373\u66FF\u8865\u987A\u5E8F" }),
          (draft.groups ?? []).length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: hint, children: "\u5C1A\u672A\u914D\u7F6E\u5206\u7EC4\u3002No groups yet." }) : null,
          (draft.groups ?? []).map((group, gi) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...card, opacity: group.id === activeId ? 1 : 0.6 }, children: [
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
                  checked: group.id === activeId,
                  label: "\u6FC0\u6D3B active",
                  onChange: () => setDraftConfig({ ...draft, activeGroup: group.id })
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", onClick: () => setDraftConfig({ ...draft, groups: (draft.groups ?? []).filter((_, i) => i !== gi) }), children: "\u5220\u9664\u7EC4" })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ol", { style: { margin: "8px 0 0", paddingLeft: 18, display: "grid", gap: 6 }, children: (group.entries ?? []).map((entry, ei) => {
              const options = modelOptions(entry.provider);
              return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { style: row, children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { opacity: 0.55, fontSize: 12, width: 22 }, children: [
                  "#",
                  ei + 1
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                  import_dsh_client_ui_primitives3.Input,
                  {
                    value: entry.provider,
                    placeholder: "provider\uFF08\u8D26\u53F7\uFF09",
                    list: "mf-provs-" + gi + "-" + ei,
                    style: { width: 190 },
                    onChange: (e) => patchGroup(gi, { entries: (group.entries ?? []).map((x, i) => i === ei ? { ...x, provider: e.target.value } : x) })
                  }
                ),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("datalist", { id: "mf-provs-" + gi + "-" + ei, children: providerIds.map((id) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: id }, id)) }),
                options.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
                  "select",
                  {
                    value: entry.model,
                    style: { padding: "4px 8px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-subtle, #8884)", background: "transparent", color: "inherit" },
                    onChange: (e) => patchGroup(gi, { entries: (group.entries ?? []).map((x, i) => i === ei ? { ...x, model: e.target.value } : x) }),
                    children: [
                      !options.some((m) => m.id === entry.model) ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: entry.model, children: entry.model }) : null,
                      options.map((m) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: m.id, children: m.name !== void 0 && m.name !== m.id ? m.name + "\uFF08" + m.id + "\uFF09" : m.id }, m.id))
                    ]
                  }
                ) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                  import_dsh_client_ui_primitives3.Input,
                  {
                    value: entry.model,
                    placeholder: "model",
                    style: { width: 170 },
                    onChange: (e) => patchGroup(gi, { entries: (group.entries ?? []).map((x, i) => i === ei ? { ...x, model: e.target.value } : x) })
                  }
                ),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", disabled: ei === 0, onClick: () => moveEntry(gi, ei, -1), title: "\u4E0A\u79FB", children: "\u2191" }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", disabled: ei === (group.entries?.length ?? 1) - 1, onClick: () => moveEntry(gi, ei, 1), title: "\u4E0B\u79FB", children: "\u2193" }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", onClick: () => duplicateEntry(gi, ei), title: "\u590D\u5236\u4E3A\u6B64\u8D26\u53F7\u7684\u66FF\u8865\uFF08\u591A Key \u591A\u8D26\u53F7\uFF09", children: "\u590D\u5236\u8D26\u53F7" }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", onClick: () => patchGroup(gi, { entries: (group.entries ?? []).filter((_, i) => i !== ei) }), title: "\u5220\u9664", children: "\u2715" })
              ] }, ei);
            }) }),
            catalogPicker(gi),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: hint, children: '\u591A\u8D26\u53F7\uFF1A\u5728 \u8BBE\u7F6E \u2192 Models \u4E3A\u540C\u4E00\u4F9B\u5E94\u5546\u6DFB\u52A0\u591A\u4E2A\u81EA\u5B9A\u4E49 provider\uFF08\u5404\u914D\u4E00\u4E2A Key\uFF09\uFF0C\u6216\u70B9"\u590D\u5236\u8D26\u53F7"\u590D\u5236\u6761\u76EE\u540E\u4FEE\u6539 provider \u540D\u3002' })
          ] }, gi)),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", onClick: () => setDraftConfig({ ...draft, groups: [...draft.groups ?? [], { id: "group-" + ((draft.groups?.length ?? 0) + 1), entries: [{ provider: draft?.groups?.[0]?.entries?.[0]?.provider ?? "", model: "" }] }] }), children: "\uFF0B \u6DFB\u52A0\u5206\u7EC4 add group" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { style: row, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { display: "grid", gap: 4 }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: sectionTitle, children: "\u51B7\u5374\uFF08\u5206\u949F\uFF09cooldown" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              import_dsh_client_ui_primitives3.Input,
              {
                type: "number",
                min: 1,
                value: draft.cooldownMinutes ?? 30,
                style: { width: 120 },
                onChange: (e) => setDraftConfig({ ...draft, cooldownMinutes: Number(e.target.value) || 30 })
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "grid", gap: 4 }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: sectionTitle, children: "\u89E6\u53D1\u5207\u6362\u7684\u9519\u8BEF\u7C7B\u522B retry on" }),
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
