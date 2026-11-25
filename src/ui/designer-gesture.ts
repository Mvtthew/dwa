// What a drag on the picture means, from where it started to where it ended. Pure, so the
// rules are tested without a terminal.
import type { Diagram, Region } from "../shared/diagram.ts";
import { type DesignView, linkOp, type Op } from "./designer-model.ts";

/** Each step's row in the picture, the top one 0. */
export function layersOf(diagram: Diagram): Record<string, number> {
  return Object.fromEntries(diagram.boxes.map((box) => [box.id, box.layer]));
}

/**
 * A step dragged onto one of the marked places is put there; dragged onto another step it is
 * joined to it: down to a later step as a dependency, up to an earlier one as its review.
 * Anything else changes nothing.
 */
export function gesture(
  design: DesignView,
  diagram: Diagram,
  from: Region | null,
  to: Region | null,
): Op | null {
  if (from?.kind !== "step" || !to) return null;
  if (to.kind === "slot") {
    const slot = diagram.slots[to.index]?.slot;
    return slot ? { op: "drop", id: from.id, slot } : null;
  }
  if (to.kind === "step") return linkOp(design, layersOf(diagram), from.id, to.id);
  return null;
}
