/**
 * Local spending-cap alerts for the Neon AI Gateway.
 *
 * This stays separate from account.ts because /neon-balance owns explicit
 * user commands, while this module owns per-turn lifecycle state.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	aggregateLocalSpend,
	fetchSpendingLimit,
	readStoredNeonCredential,
	formatUsd,
} from "./account.js";
import { resolveNeonManagementKey } from "./config.js";

export const ALERT_THRESHOLDS = [50, 80, 95] as const;
const CAP_CACHE_TTL_MS = 15 * 60 * 1000;

/** Clear the in-memory cap cache after a successful limit mutation. */
export function invalidateNeonCapCache(): void {
	// Alert hooks keep their cache private to each registered hook. This hook is
	// intentionally a no-op until a shared cache is introduced.
}

interface CapCache {
	cap: number | null;
	fetchedAt: number;
	managementKey: string;
	orgId: string;
}

/**
 * Register warnings for local spend crossing 50%, 80%, and 95% of the
 * configured cap. Alerts intentionally use local spend language because
 * this extension cannot observe usage from other machines.
 */
export function registerNeonAlertHooks(pi: ExtensionAPI): void {
	let warnedThresholds = new Set<number>();
	let capCache: CapCache | undefined;

	pi.on("before_agent_start", async (_event, ctx) => {
		try {
			const stored = await readStoredNeonCredential();
			const managementKey = resolveNeonManagementKey({
				processEnv: process.env as Record<string, string | undefined>,
				storedManagementKey: stored.managementKey,
			});
			if (!managementKey || !stored.orgId) return;

			if (capCache && capCache.managementKey !== managementKey) {
				capCache = undefined;
				warnedThresholds = new Set<number>();
			}

			const local = await aggregateLocalSpend(getAgentDir());
			if (local.totalCost <= 0 || local.sessionCount === 0) return;

			const now = Date.now();
			let cap: number | null;
			if (capCache && now - capCache.fetchedAt < CAP_CACHE_TTL_MS && capCache.orgId === stored.orgId) {
				cap = capCache.cap;
			} else {
				cap = await fetchSpendingLimit(stored.orgId, managementKey);
				capCache = { cap, fetchedAt: now, managementKey, orgId: stored.orgId };
			}
			if (cap === null || cap <= 0) return;

			const usedPct = (local.totalCost / cap) * 100;
			for (const threshold of ALERT_THRESHOLDS) {
				if (usedPct < threshold || warnedThresholds.has(threshold)) continue;
				warnedThresholds.add(threshold);
				ctx.ui.notify(
					`Neon local spend alert: this machine has used ${formatUsd(local.totalCost)} (${threshold}%+ of the ${formatUsd(cap)} spending cap).`,
					"warning",
				);
			}
		} catch {
			// Alerts must never prevent a user prompt from reaching the agent.
		}
	});
}
