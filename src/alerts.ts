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

interface CapCache {
	cap: number | null;
	fetchedAt: number;
	managementKey: string;
	orgId: string;
}

interface StatusContext {
	ui: {
		setStatus: (key: string, value: string) => void;
		notify?: (message: string, level: string) => void;
	};
}

let publishContext: StatusContext | undefined;
let publishCache: CapCache | undefined;

/**
 * Publish the cap and this machine's local spend percentage for the
 * powerline-footer extension. Missing credentials, org id, and fetch errors
 * intentionally leave the previous status untouched.
 */
export async function publishNeonCapStatus(ctx: StatusContext): Promise<void> {
	const stored = await readStoredNeonCredential();
	const managementKey = resolveNeonManagementKey({
		processEnv: process.env as Record<string, string | undefined>,
		storedManagementKey: stored.managementKey,
	});
	if (!managementKey || !stored.orgId) return;

	const now = Date.now();
	let cap: number | null;
	if (
		publishCache &&
		publishCache.managementKey === managementKey &&
		publishCache.orgId === stored.orgId &&
		now - publishCache.fetchedAt < CAP_CACHE_TTL_MS
	) {
		cap = publishCache.cap;
	} else {
		cap = await fetchSpendingLimit(stored.orgId, managementKey);
		publishCache = { cap, fetchedAt: now, managementKey, orgId: stored.orgId };
	}
	if (cap === null || cap <= 0) {
		ctx.ui.setStatus("neon-cap", "no cap");
		return;
	}

	const local = await aggregateLocalSpend(getAgentDir());
	const percentage = Math.min(100, Math.round((local.totalCost / cap) * 100));
	ctx.ui.setStatus("neon-cap", `${formatUsd(cap)} · ${percentage}%`);
}

/**
 * Register warnings for local spend crossing 50%, 80%, and 95% of the
 * configured cap. Alerts intentionally use local spend language because
 * this extension cannot observe usage from other machines.
 */
export function registerNeonAlertHooks(pi: ExtensionAPI): void {
	// Each Pi runtime registers this once; resetting also keeps repeated test
	// registrations from sharing stale account state.
	publishCache = undefined;
	let warnedThresholds = new Set<number>();
	let capCache: CapCache | undefined;

	pi.on("session_start", async (_event, ctx) => {
		try {
			publishContext = ctx as unknown as StatusContext;
			await publishNeonCapStatus(publishContext);
		} catch {
			// Status publishing must never prevent session startup.
		}
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		try {
			publishContext = ctx as unknown as StatusContext;
			await publishNeonCapStatus(publishContext);

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
