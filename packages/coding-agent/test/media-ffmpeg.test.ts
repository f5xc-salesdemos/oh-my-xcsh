import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { decodeRasterFrames } from "../src/media/ffmpeg";

const ffmpeg = Bun.which("ffmpeg");
const encoders = ffmpeg ? Bun.spawnSync([ffmpeg, "-hide_banner", "-encoders"]) : undefined;
if (encoders && encoders.exitCode !== 0) throw new Error(encoders.stderr.toString());
const hasWebpEncoder = /\blibwebp_anim\b/.test(encoders?.stdout.toString() ?? "");

function generateVideo(): Buffer {
	if (!ffmpeg) throw new Error("ffmpeg unavailable");
	const result = Bun.spawnSync([
		ffmpeg,
		"-v",
		"error",
		"-f",
		"lavfi",
		"-i",
		"testsrc=size=24x16:rate=6:duration=0.5",
		"-an",
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		"-movflags",
		"frag_keyframe+empty_moov",
		"-f",
		"mp4",
		"pipe:1",
	]);
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return Buffer.from(result.stdout);
}

function generateAnimation(format: "gif" | "webp"): Buffer {
	if (!ffmpeg) throw new Error("ffmpeg unavailable");
	const codec = format === "webp" ? ["-c:v", "libwebp_anim", "-loop", "0"] : [];
	const result = Bun.spawnSync([
		ffmpeg,
		"-v",
		"error",
		"-f",
		"lavfi",
		"-i",
		"testsrc=size=24x16:rate=6:duration=0.5",
		"-an",
		...codec,
		"-f",
		format,
		"pipe:1",
	]);
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return Buffer.from(result.stdout);
}

describe.skipIf(!ffmpeg)("decodeRasterFrames", () => {
	test("streams bounded silent PNG frames at the requested FPS cap", async () => {
		const decoded = await decodeRasterFrames(generateVideo(), {
			ffmpegPath: ffmpeg!,
			fpsCap: 4,
			maxFrames: 10,
			maxOutputBytes: 2 * 1024 * 1024,
		});

		expect(decoded).not.toBeNull();
		expect(decoded!.length).toBeGreaterThan(1);
		expect(decoded!.length).toBeLessThanOrEqual(10);
		for (const frame of decoded!) {
			expect(frame.data.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]));
			expect(frame.durationMs).toBeGreaterThanOrEqual(250);
		}
	});

	for (const format of ["gif", "webp"] as const) {
		const missingEncoder = format === "webp" && !hasWebpEncoder;
		test.skipIf(missingEncoder)(
			`decodes animated ${format}${missingEncoder ? " (fixture unavailable: FFmpeg lacks libwebp_anim encoder)" : ""}`,
			async () => {
				const decoded = await decodeRasterFrames(generateAnimation(format), {
					ffmpegPath: ffmpeg!,
					fpsCap: 6,
					maxFrames: 10,
				});
				expect(decoded?.length).toBeGreaterThan(1);
			},
		);
	}

	test("rejects corrupt media and output that exceeds the streaming bound", async () => {
		expect(await decodeRasterFrames(Buffer.from("not-media"), { ffmpegPath: ffmpeg! })).toBeNull();
		expect(
			await decodeRasterFrames(generateVideo(), {
				ffmpegPath: ffmpeg!,
				maxOutputBytes: 32,
			}),
		).toBeNull();
	});
});

test("missing FFmpeg degrades without throwing", async () => {
	expect(await decodeRasterFrames(Buffer.from("anything"), { ffmpegPath: "/missing/ffmpeg" })).toBeNull();
});

test("orders double-digit animated WebP fallback frames numerically", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xcsh-webp-order-test-"));
	try {
		const ffmpegPath = path.join(directory, "ffmpeg");
		const webpmuxPath = path.join(directory, "webpmux");
		const animDumpPath = path.join(directory, "anim_dump");
		await fs.writeFile(
			ffmpegPath,
			`#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" -vcodec pam "* ]]; then
	cat
	exit 0
fi
cat >/dev/null
exit 1
`,
			{ mode: 0o755 },
		);
		await fs.writeFile(
			webpmuxPath,
			`#!/usr/bin/env bash
cat <<'EOF'
Canvas size: 1 x 1
Number of frames: 12
  1: 1 1 no 0 0 101
  2: 1 1 no 0 0 102
  3: 1 1 no 0 0 103
  4: 1 1 no 0 0 104
  5: 1 1 no 0 0 105
  6: 1 1 no 0 0 106
  7: 1 1 no 0 0 107
  8: 1 1 no 0 0 108
  9: 1 1 no 0 0 109
  10: 1 1 no 0 0 110
  11: 1 1 no 0 0 111
  12: 1 1 no 0 0 112
EOF
`,
			{ mode: 0o755 },
		);
		await fs.writeFile(
			animDumpPath,
			`#!/usr/bin/env bash
set -euo pipefail
folder=""
while (( $# )); do
	case "$1" in
		-folder) folder="$2"; shift 2 ;;
		*) shift ;;
	esac
done
for i in {0..11}; do
	printf '%s' "$i" >"$folder/frame_$i.pam"
done
`,
			{ mode: 0o755 },
		);

		const decoded = await decodeRasterFrames(Buffer.from("RIFF0000WEBPANIM"), {
			ffmpegPath,
			webpmuxPath,
			animDumpPath,
			fpsCap: 60,
			maxFrames: 12,
		});

		expect(decoded?.map(frame => frame.data.toString("utf8"))).toEqual(
			Array.from({ length: 12 }, (_, index) => String(index)),
		);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
