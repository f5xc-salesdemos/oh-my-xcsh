import { Command, Flags } from "@f5-sales-demo/pi-utils/cli";
import { nativeLifecycleContract } from "../lifecycle/native-acceptance";

/** Print the versioned producer contract consumed by native lifecycle drivers. */
export default class Lifecycle extends Command {
	static description = "Describe the native lifecycle acceptance control contract";

	static flags = {
		json: Flags.boolean({ description: "Print the machine-readable contract", default: false }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Lifecycle);
		if (!flags.json) throw new Error("xcsh lifecycle requires --json");
		process.stdout.write(`${JSON.stringify(nativeLifecycleContract())}\n`);
	}
}
