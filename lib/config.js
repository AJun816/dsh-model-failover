/**
 * Plugin configuration: runtime schema and group resolution.
 *
 * @module dsh-model-failover/config
 */
import z from '@deepseek-ai/schemastery';
/**
 * Runtime schema for {@link Config}. Every field is volatile so GUI edits
 * re-wire the listeners without a restart.
 */
export const Config = z.object({
    groups: z.array(z.object({
        id: z.string().required(),
        entries: z.array(z.object({
            provider: z.string().required(),
            model: z.string().required(),
        })).required(),
    })).default([]).volatile(),
    activeGroup: z.string().default('').volatile(),
    cooldownMinutes: z.number().default(30).volatile(),
    retryOn: z.array(z.string()).default(['quota', 'rate-limit', 'auth', 'network']).volatile(),
    autoDiscover: z.boolean().default(true).volatile(),
    // Default false since v0.9.3: the configured chain is authoritative.
    // Catalog fallback is opt-in (it once routed traffic into a channel the
    // user never configured — see CHANGELOG 0.9.2/0.9.3).
    fallbackToCatalog: z.boolean().default(false).volatile(),
    catalogExclude: z.array(z.string()).default([]).volatile(),
    lastSwitches: z.array(z.object({
        at: z.number().required(),
        from: z.string().required(),
        to: z.string().required(),
        reason: z.string().required(),
        via: z.string().required(),
    })).default([]).volatile(),
});
/**
 * The active group: the configured activeGroup id when it matches, else the
 * first group. Undefined when no group is usable.
 */
export function activeGroupOf(config) {
    if (!Array.isArray(config.groups) || config.groups.length === 0)
        return undefined;
    const wanted = config.activeGroup || config.groups[0]?.id;
    return config.groups.find((group) => group.id === wanted) ?? config.groups[0];
}
