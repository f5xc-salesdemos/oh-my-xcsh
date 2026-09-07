import * as os from "node:os";
import type { AgentMessage } from "@f5-sales-demo/pi-agent-core";
import { buildCopyTargets, initialCopyEntries } from "../src/modes/utils/copy-targets";
import type { SessionMessageEntry } from "../src/session/session-manager";

interface RunMetrics {
	initialMs: number;
	unboundedMs: number;
	initialTouched: number;
	byteEquivalent: boolean;
	boundedNavigationP95Ms: number;
	fullTailNavigationP95Ms: number;
	rssBytes: number;
	totalMemoryBytes: number;
}

function percentile(values: number[], fraction: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function median(values: number[]): number {
	return percentile(values, 0.5);
}

function entry(index: number): SessionMessageEntry {
	const message: AgentMessage =
		index % 3 === 0
			? { role: "user", content: `request ${index}`, timestamp: index }
			: ({
					role: "assistant",
					content: [{ type: "text", text: `response ${index} https://example.test/${index}` }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "benchmark",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: index,
				} as AgentMessage);
	return { type: "message", id: `entry-${index}`, parentId: null, timestamp: String(index), message };
}

function navigationP95(targets: ReturnType<typeof buildCopyTargets>): number {
	const samples: number[] = [];
	let cursor = 0;
	for (let sample = 0; sample < 100; sample++) {
		const start = performance.now();
		for (let step = 0; step < 1_000; step++) {
			cursor = (cursor + 1) % targets.length;
			void targets[cursor]?.blocks.length;
		}
		samples.push(performance.now() - start);
	}
	return percentile(samples, 0.95);
}

function runOnce(): RunMetrics {
	const entries = Array.from({ length: 30_000 }, (_, index) => entry(index));
	const unboundedStart = performance.now();
	const full = buildCopyTargets(entries);
	const unboundedMs = performance.now() - unboundedStart;

	const initialStart = performance.now();
	const projection = initialCopyEntries(entries);
	const bounded = buildCopyTargets(projection.entries);
	const initialMs = performance.now() - initialStart;
	const firstId = bounded[0]?.id;
	const fullTail = firstId ? full.slice(full.findIndex(target => target.id === firstId)) : [];

	return {
		initialMs,
		unboundedMs,
		initialTouched: projection.touched,
		byteEquivalent: JSON.stringify(bounded) === JSON.stringify(fullTail),
		boundedNavigationP95Ms: navigationP95(bounded),
		fullTailNavigationP95Ms: navigationP95(fullTail),
		rssBytes: process.memoryUsage.rss(),
		totalMemoryBytes: os.totalmem(),
	};
}

if (process.argv.includes("--child")) {
	console.log(JSON.stringify(runOnce()));
} else {
	const runs: RunMetrics[] = [];
	for (let index = 0; index < 5; index++) {
		const child = Bun.spawnSync([process.execPath, import.meta.path, "--child"], {
			stdout: "pipe",
			stderr: "inherit",
		});
		if (child.exitCode !== 0) throw new Error(`benchmark child ${index + 1} failed`);
		runs.push(JSON.parse(child.stdout.toString().trim()) as RunMetrics);
	}
	const initialMedian = median(runs.map(run => run.initialMs));
	const unboundedMedian = median(runs.map(run => run.unboundedMs));
	const improvement = 1 - initialMedian / unboundedMedian;
	const boundedNavigationP95 = percentile(
		runs.flatMap(run => [run.boundedNavigationP95Ms]),
		0.95,
	);
	const fullTailNavigationP95 = percentile(
		runs.flatMap(run => [run.fullTailNavigationP95Ms]),
		0.95,
	);
	const peakMemoryRatio = Math.max(...runs.map(run => run.rssBytes / run.totalMemoryBytes));
	const report = {
		runs,
		initialMedianMs: initialMedian,
		unboundedMedianMs: unboundedMedian,
		improvementPercent: improvement * 100,
		boundedNavigationP95Ms: boundedNavigationP95,
		fullTailNavigationP95Ms: fullTailNavigationP95,
		peakMemoryPercent: peakMemoryRatio * 100,
	};
	console.log(JSON.stringify(report, null, 2));
	if (runs.some(run => run.initialTouched > 600 || !run.byteEquivalent)) process.exitCode = 1;
	if (improvement < 0.2 || peakMemoryRatio >= 0.8) process.exitCode = 1;
	// Both models contain the same tail. Allow a small timer-noise margin while rejecting material regressions.
	if (boundedNavigationP95 > fullTailNavigationP95 * 1.15 + 0.02) process.exitCode = 1;
}
