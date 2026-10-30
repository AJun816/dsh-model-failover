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
var import_jsx_runtime = require("react/jsx-runtime");
var NS = "model-failover";
var RETRY_CLASSES = ["quota", "rate-limit", "auth", "network"];
var label = { margin: "4px 0", fontWeight: 600 };
var input = {
  padding: "4px 8px",
  borderRadius: 6,
  border: "1px solid var(--dsh-border, #555)",
  background: "var(--dsh-input-bg, transparent)",
  color: "inherit",
  minWidth: 120
};
var button = { padding: "4px 10px", borderRadius: 6, cursor: "pointer" };
var muted = { opacity: 0.7, fontSize: 12 };
function FailoverCard(props) {
  const [config, setConfig] = (0, import_react.useState)(null);
  const [revision, setRevision] = (0, import_react.useState)(void 0);
  const [writable, setWritable] = (0, import_react.useState)(true);
  const [status, setStatus] = (0, import_react.useState)("");
  const [busy, setBusy] = (0, import_react.useState)(false);
  const remote = props.remote;
  (0, import_react.useEffect)(() => {
    if (remote === void 0 || props.view === "summary") return;
    let alive = true;
    void (async () => {
      try {
        const response = await remote.settings.describe();
        if (!alive) return;
        if (response?.ok !== true) {
          setStatus("\u8BFB\u53D6\u914D\u7F6E\u5931\u8D25 / failed to read settings");
          return;
        }
        const view = response.value?.namespaces?.find((row) => row.ns === NS);
        if (view === void 0) {
          setStatus("\u547D\u540D\u7A7A\u95F4\u672A\u5C31\u7EEA\uFF08\u63D2\u4EF6\u53EF\u80FD\u672A\u542F\u7528\uFF09/ namespace not served");
          return;
        }
        setConfig(view.value ?? {});
        setRevision(view.revision);
        setWritable(view.writable !== false);
      } catch (error) {
        if (alive) setStatus(String(error));
      }
    })();
    return () => {
      alive = false;
    };
  }, [remote, props.view]);
  const mutate = (0, import_react.useCallback)((next) => {
    setConfig(next);
  }, []);
  const save = (0, import_react.useCallback)(async () => {
    if (remote === void 0 || config === null) return;
    setBusy(true);
    setStatus("");
    try {
      const response = await remote.settings.update(NS, config, revision);
      if (response?.ok !== true) {
        setStatus("\u4FDD\u5B58\u5931\u8D25\uFF1A" + (response?.error?.message ?? "unknown") + "\uFF08\u914D\u7F6E\u53EF\u80FD\u5DF2\u88AB\u5176\u4ED6\u7A97\u53E3\u4FEE\u6539\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u91CD\u8BD5\uFF09");
      } else {
        const view = response.value?.namespaces?.find((row) => row.ns === NS);
        setRevision(view?.revision ?? revision);
        setConfig(view?.value ?? config);
        setStatus("\u5DF2\u4FDD\u5B58 / saved \u2014 \u914D\u7F6E\u5373\u65F6\u751F\u6548\uFF0C\u65E0\u9700\u91CD\u542F");
      }
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(false);
    }
  }, [remote, config, revision]);
  if (props.view === "summary") {
    return "\u591A\u4F9B\u5E94\u5546 / \u591A\u8D26\u53F7\u6A21\u578B\u81EA\u52A8\u66FF\u8865\uFF1A\u989D\u5EA6\u7528\u5B8C\u81EA\u52A8\u5207\u6362\u4E0B\u4E00\u68D2\uFF08Model & account failover\uFF09";
  }
  if (config === null) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: muted, children: status || "\u52A0\u8F7D\u4E2D\u2026 / loading\u2026" });
  }
  const groups = config.groups ?? [];
  const active = config.activeGroup || groups[0]?.id || "";
  const patchGroup = (index, patch) => {
    const next = groups.map((group, i) => i === index ? { ...group, ...patch } : group);
    mutate({ ...config, groups: next });
  };
  const moveEntry = (groupIndex, entryIndex, delta) => {
    const entries = [...groups[groupIndex]?.entries ?? []];
    const target = entryIndex + delta;
    if (target < 0 || target >= entries.length) return;
    [entries[entryIndex], entries[target]] = [entries[target], entries[entryIndex]];
    patchGroup(groupIndex, { entries });
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "grid", gap: 12 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { style: label, children: "\u66FF\u8865\u94FE Fallback groups" }),
      groups.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: muted, children: "\u5C1A\u672A\u914D\u7F6E\u5206\u7EC4\u3002No groups yet." }) : null,
      groups.map((group, gi) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { border: "1px solid var(--dsh-border,#444)", borderRadius: 8, padding: 10, marginBottom: 10, opacity: group.id === active ? 1 : 0.65 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              style: input,
              value: group.id,
              placeholder: "group id",
              onChange: (e) => patchGroup(gi, { id: e.target.value })
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: muted, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                type: "radio",
                name: "mf-active",
                checked: group.id === active,
                onChange: () => mutate({ ...config, activeGroup: group.id })
              }
            ),
            " \u6FC0\u6D3B active"
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { style: button, onClick: () => mutate({ ...config, groups: groups.filter((_, i) => i !== gi) }), children: "\u5220\u9664\u7EC4" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ol", { style: { margin: "8px 0 0", paddingLeft: 20 }, children: (group.entries ?? []).map((entry, ei) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { style: { display: "flex", gap: 6, alignItems: "center", margin: "4px 0", flexWrap: "wrap" }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { ...muted, opacity: 1 }, children: [
            "#",
            ei + 1
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              style: input,
              value: entry.provider,
              placeholder: "provider\uFF08\u5982 glm-1\uFF09",
              onChange: (e) => patchGroup(gi, { entries: (group.entries ?? []).map((x, i) => i === ei ? { ...x, provider: e.target.value } : x) })
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              style: input,
              value: entry.model,
              placeholder: "model\uFF08\u5982 glm-4.7\uFF09",
              onChange: (e) => patchGroup(gi, { entries: (group.entries ?? []).map((x, i) => i === ei ? { ...x, model: e.target.value } : x) })
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { style: button, onClick: () => moveEntry(gi, ei, -1), disabled: ei === 0, children: "\u2191" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { style: button, onClick: () => moveEntry(gi, ei, 1), disabled: ei === (group.entries?.length ?? 1) - 1, children: "\u2193" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { style: button, onClick: () => patchGroup(gi, { entries: (group.entries ?? []).filter((_, i) => i !== ei) }), children: "\u2715" })
        ] }, ei)) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            style: { ...button, marginTop: 6 },
            onClick: () => patchGroup(gi, { entries: [...group.entries ?? [], { provider: "", model: "" }] }),
            children: "\uFF0B \u6DFB\u52A0\u6761\u76EE entry\uFF08\u987A\u5E8F\u5373\u66FF\u8865\u987A\u5E8F\uFF09"
          }
        )
      ] }, group.id || gi)),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          style: button,
          onClick: () => mutate({ ...config, groups: [...groups, { id: "group-" + (groups.length + 1), entries: [{ provider: "", model: "" }] }] }),
          children: "\uFF0B \u6DFB\u52A0\u5206\u7EC4 add group"
        }
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { style: { display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { display: "grid", gap: 4 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: label, children: "\u51B7\u5374\uFF08\u5206\u949F\uFF09cooldown" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "input",
          {
            style: input,
            type: "number",
            min: 1,
            value: config.cooldownMinutes ?? 30,
            onChange: (e) => mutate({ ...config, cooldownMinutes: Number(e.target.value) || 30 })
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "grid", gap: 4 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: label, children: "\u89E6\u53D1\u5207\u6362\u7684\u9519\u8BEF\u7C7B\u522B retry on" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { display: "flex", gap: 10, flexWrap: "wrap" }, children: RETRY_CLASSES.map((klass) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: muted, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              type: "checkbox",
              checked: (config.retryOn ?? RETRY_CLASSES).includes(klass),
              onChange: (e) => {
                const current = new Set(config.retryOn ?? RETRY_CLASSES);
                if (e.target.checked) current.add(klass);
                else current.delete(klass);
                mutate({ ...config, retryOn: [...current] });
              }
            }
          ),
          " ",
          klass
        ] }, klass)) })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("footer", { style: { display: "flex", gap: 10, alignItems: "center" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { style: { ...button, fontWeight: 600 }, disabled: busy || !writable, onClick: () => void save(), children: busy ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58 / Save" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: muted, children: [
        status,
        !writable ? "\uFF08\u53EA\u8BFB / read-only\uFF09" : ""
      ] })
    ] })
  ] });
}
var inject = ["slots", "remote"];
function apply(ctx) {
  const register = () => ctx.slots.inject("plugins.item", () => ctx.slots.register({
    name: "plugins.item",
    id: "model-failover",
    order: 40,
    label: () => "Model Failover \u6A21\u578B\u66FF\u8865"
  }, (props) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(FailoverCard, { ...props, remote: ctx.remote })));
  if (ctx.effect !== void 0) {
    ctx.effect(register, "model-failover: plugins card");
  } else {
    register();
  }
}
    return module.exports;
  }
});
