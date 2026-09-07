import { beforeAll, describe, expect, it } from "bun:test";
import { ExtensionList } from "../src/modes/components/extensions/extension-list";
import type { Extension } from "../src/modes/components/extensions/types";
import { initTheme } from "../src/modes/theme/theme";

beforeAll(() => initTheme());

function skill(name: string): Extension {
	return {
		id: `skill:${name}`,
		kind: "skill",
		name,
		displayName: name,
		path: `/tmp/${name}`,
		source: { provider: "native", providerName: "Native", level: "native" },
		state: "active",
		raw: {},
	};
}

describe("ExtensionList mouse", () => {
	it("keeps chrome and group headings non-actionable", () => {
		const toggled: string[] = [];
		const list = new ExtensionList([skill("alpha"), skill("beta")], { onToggle: id => toggled.push(id) });
		list.setFocused(true);
		list.render(60);
		list.handleClick(0);
		list.handleClick(1);
		list.handleClick(2);
		expect(list.getSelectedExtension()).toBeNull();
		expect(toggled).toEqual([]);
	});

	it("selects, activates, and wheel-navigates extension rows", () => {
		const selected: Array<string | null> = [];
		const toggled: string[] = [];
		const list = new ExtensionList([skill("alpha"), skill("beta")], {
			onSelectionChange: item => selected.push(item?.id ?? null),
			onToggle: id => toggled.push(id),
		});
		list.setFocused(true);
		list.render(60);
		list.handleClick(3);
		list.handleClick(3);
		list.handleWheel(1);
		expect(list.getSelectedExtension()?.id).toBe("skill:beta");
		expect(selected).toEqual(["skill:alpha", "skill:beta"]);
		expect(toggled).toEqual(["skill:alpha"]);
	});
});
