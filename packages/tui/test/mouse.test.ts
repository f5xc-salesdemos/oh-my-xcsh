import { describe, expect, it } from "bun:test";
import {
	parseSgrMouse,
	routeSelectListMouse,
	routeSgrMouseInput,
	type SelectListMouseTarget,
	type SgrMouseEvent,
} from "../src/mouse";

const baseEvent: SgrMouseEvent = {
	button: 0,
	col: 0,
	row: 0,
	release: false,
	wheel: null,
	motion: false,
	leftClick: false,
};

describe("SGR mouse routing", () => {
	it("decodes clicks, releases, motion, and vertical wheel coordinates", () => {
		expect(parseSgrMouse("\x1b[<0;5;9M")).toEqual({
			button: 0,
			col: 4,
			row: 8,
			release: false,
			wheel: null,
			motion: false,
			leftClick: true,
		});
		expect(parseSgrMouse("\x1b[<0;5;9m")?.leftClick).toBe(false);
		expect(parseSgrMouse("\x1b[<35;1;1M")?.motion).toBe(true);
		expect(parseSgrMouse("\x1b[<64;1;1M")?.wheel).toBe(-1);
		expect(parseSgrMouse("\x1b[<65;1;1M")?.wheel).toBe(1);
	});

	it("rejects horizontal wheel drift", () => {
		expect(parseSgrMouse("\x1b[<66;1;1M")?.wheel).toBeNull();
		expect(parseSgrMouse("\x1b[<67;1;1M")?.wheel).toBeNull();
	});

	it("only routes complete SGR reports", () => {
		let received: SgrMouseEvent | undefined;
		expect(
			routeSgrMouseInput("a", event => {
				received = event;
			}),
		).toBe(false);
		expect(received).toBeUndefined();
		expect(
			routeSgrMouseInput("\x1b[<0;2;3M", event => {
				received = event;
			}),
		).toBe(true);
		expect(received?.row).toBe(2);
	});

	it("routes wheel, hover, and click through hit testing", () => {
		const calls: string[] = [];
		const target: SelectListMouseTarget = {
			handleWheel: delta => calls.push(`wheel:${delta}`),
			hitTest: () => 2,
			setHoverIndex: index => calls.push(`hover:${index}`),
			clickItem: index => calls.push(`click:${index}`),
		};
		expect(routeSelectListMouse(target, { ...baseEvent, wheel: 1 }, 0)).toBe(true);
		expect(routeSelectListMouse(target, { ...baseEvent, motion: true }, 0)).toBe(true);
		expect(routeSelectListMouse(target, { ...baseEvent, leftClick: true }, 0)).toBe(true);
		expect(calls).toEqual(["wheel:1", "hover:2", "click:2"]);
	});
});
