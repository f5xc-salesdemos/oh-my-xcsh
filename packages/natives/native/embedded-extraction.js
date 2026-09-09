const fs = require("node:fs");

function isExpectedFile(fsImpl, filePath, expectedSize) {
	try {
		const stat = fsImpl.statSync(filePath);
		return stat.isFile() && stat.size === expectedSize;
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

function unlinkIfPresent(fsImpl, filePath) {
	try {
		fsImpl.unlinkSync(filePath);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
}

/**
 * Materialize an embedded native addon without ever exposing a partial final
 * file. Existing files from interrupted older extractions are repaired when
 * their size differs from the embedded asset.
 */
function ensureEmbeddedAddon({ sourcePath, targetPath, fsImpl = fs }) {
	const expectedSize = fsImpl.statSync(sourcePath).size;
	if (isExpectedFile(fsImpl, targetPath, expectedSize)) return targetPath;

	const buffer = fsImpl.readFileSync(sourcePath);
	if (buffer.length !== expectedSize) {
		throw new Error(`Embedded addon changed while reading: expected ${expectedSize} bytes, got ${buffer.length}`);
	}

	const temporaryPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	let temporaryExists = false;
	try {
		fsImpl.writeFileSync(temporaryPath, buffer, { flag: "wx", mode: 0o600 });
		temporaryExists = true;
		try {
			fsImpl.renameSync(temporaryPath, targetPath);
			temporaryExists = false;
		} catch (error) {
			if (!error || !["EACCES", "EEXIST", "EPERM"].includes(error.code)) throw error;
			if (isExpectedFile(fsImpl, targetPath, expectedSize)) return targetPath;
			unlinkIfPresent(fsImpl, targetPath);
			fsImpl.renameSync(temporaryPath, targetPath);
			temporaryExists = false;
		}

		if (!isExpectedFile(fsImpl, targetPath, expectedSize)) {
			throw new Error(`Extracted addon has an unexpected size: ${targetPath}`);
		}
		return targetPath;
	} finally {
		if (temporaryExists) unlinkIfPresent(fsImpl, temporaryPath);
	}
}

module.exports = { ensureEmbeddedAddon, isExpectedFile };
