import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { AI_GATEWAY_MIN_BALANCE_CENTS, aggregateLocalSpend, fetchAiGatewayCreditBalance, fetchSpendingLimit, formatUsd, readStoredNeonCredential } from "./account.js";
import { readAuthFile, writeAuthFile } from "./auth.js";
import { resolveNeonManagementKey } from "./config.js";

const PROVIDER_ID = "neon";

export function readCapBlockEnabled(): boolean {
	const file = readAuthFile();
	const stored = file[PROVIDER_ID];
	return Boolean(stored && typeof stored === "object" && (stored as Record<string, unknown>).capBlockEnabled === true);
}

async function persistCapBlockEnabled(enabled: boolean): Promise<void> {
	const file = readAuthFile();
	const stored = file[PROVIDER_ID];
	const credential = stored && typeof stored === "object" ? { ...(stored as Record<string, unknown>) } : {};
	credential.capBlockEnabled = enabled;
	file[PROVIDER_ID] = credential;
	await writeAuthFile(file);
}

export function registerNeonCapBlockCommand(pi: ExtensionAPI): void {
	pi.registerCommand("neon-cap-block", {
		description: "Enable or disable blocking turns at the local Neon cap or below $2 credit",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (command === "on" || command === "off") {
				const stored = await readStoredNeonCredential();
				const managementKey = resolveNeonManagementKey({ processEnv: process.env as Record<string, string | undefined>, storedManagementKey: stored.managementKey });
				if (!managementKey) {
					ctx.ui.notify("Neon cap blocking unavailable: no management key configured.", "warning");
					return;
				}
				await persistCapBlockEnabled(command === "on");
				ctx.ui.notify(`Neon cap blocking ${command === "on" ? "enabled" : "disabled"}.`, "info");
				return;
			}
			if (command !== "" && command !== "status") {
				ctx.ui.notify("Usage: /neon-cap-block [on | off | status]", "warning");
				return;
			}
			const enabled = readCapBlockEnabled();
			const stored = await readStoredNeonCredential();
			const managementKey = resolveNeonManagementKey({ processEnv: process.env as Record<string, string | undefined>, storedManagementKey: stored.managementKey });
			if (!managementKey) {
				ctx.ui.notify(`Neon cap blocking is ${enabled ? "enabled" : "disabled"}, but no management key is configured.`, "warning");
				return;
			}
			ctx.ui.notify(`Neon cap blocking is ${enabled ? "enabled" : "disabled"}.`, "info");
		},
	});
}

export function registerNeonCapBlockGuard(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (_event, ctx) => {
		if (!readCapBlockEnabled()) return;
		try {
			const stored = await readStoredNeonCredential();
			const managementKey = resolveNeonManagementKey({ processEnv: process.env as Record<string, string | undefined>, storedManagementKey: stored.managementKey });
			if (!managementKey || !stored.orgId) return;
			const [cap, balance, local] = await Promise.all([
				fetchSpendingLimit(stored.orgId, managementKey).catch(() => null),
				fetchAiGatewayCreditBalance(stored.orgId, managementKey),
				aggregateLocalSpend(getAgentDir()),
			]);
			let reason: string;
			if (balance !== null && balance.balanceCents < AI_GATEWAY_MIN_BALANCE_CENTS) {
				reason = `current prepaid balance ${formatUsd(balance.balanceCents / 100)} is below the ${formatUsd(AI_GATEWAY_MIN_BALANCE_CENTS / 100)} minimum. Add credits in the Neon Console to resume Gateway calls; a temporary retry does not replenish credits.`;
			} else if (cap !== null && local.totalCost >= cap) {
				reason = `local spend ${formatUsd(local.totalCost)} has reached the local comparison cap of ${formatUsd(cap)} on this machine.`;
			} else {
				return;
			}
			const message = `Neon cap block: ${reason} This opt-in guard prevented the agent turn. Run /neon-cap-block off to disable it.`;
			ctx.ui.notify(message, "error");
			return { message: { customType: "neon-cap-block", content: message, display: true } };
		} catch {
			// Fail open if the limit cannot be verified.
		}
	});
}
