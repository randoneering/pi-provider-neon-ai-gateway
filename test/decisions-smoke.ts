import { readNeonDecisionCredential } from "../src/decision-tool.js";
import { decisionUsage, requestNeonDecision } from "../src/decisions.js";

async function main(): Promise<void> {
	const ids = process.argv.slice(2);
	if (ids.length > 1) throw new Error("Specify at most one decision model ID.");
	const model = ids[0] ?? "typesafeai-jev-1-14-0";
	const result = await requestNeonDecision({
		model,
		state: "I was charged twice this month. Please refund the duplicate payment.",
		questions: {
			refund: { type: "noul", instructions: "Does the customer request a refund?" },
			department: { type: "choice", instructions: "Which team should handle this?", criteria: { billing: "Payments and refunds", technical: "Software bugs" } },
			severity: { type: "score", instructions: "How serious is this billing issue?", criteria: ["Cosmetic", "Customer was charged incorrectly", "Customer cannot access the service"] },
		},
	}, { credential: readNeonDecisionCredential(), signal: AbortSignal.timeout(30_000) });
	const department = result.answers.department;
	if (department?.type !== "choice" || department.choice !== "billing") {
		throw new Error("Decision smoke check expected the billing department.");
	}
	console.log(`Decision smoke passed: ${model}; served by ${result.model}; input tokens ${result.usage.input_tokens}; cost $${decisionUsage(result, model).cost.total.toFixed(8)}`);
}

main().catch((error: unknown) => {
	console.error("Decision smoke failed:", error instanceof Error ? error.message : "Unknown error");
	process.exitCode = 1;
});
