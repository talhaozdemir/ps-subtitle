/* SPDX-License-Identifier: AGPL-3.0-only */
#include "ocr_pending.h"

enum { PENDING_MAX_AGE_MS = 1500, SUBTITLE_GAP_MS = 380 };

static void expire(struct ocr_pending *pending, uint64_t now) {
    for (int index = 0; index < OCR_PENDING_SLOTS; index++) {
        struct ocr_pending_slot *slot = &pending->slots[index];
        if (slot->occupied && now - slot->captured_at > PENDING_MAX_AGE_MS) {
            slot->occupied = false;
            pending->expired++;
        }
    }
}

bool ocr_pending_waiting(struct ocr_pending *pending, uint64_t now) {
    expire(pending, now);
    return pending->slots[0].occupied || pending->slots[1].occupied;
}

int ocr_pending_offer(struct ocr_pending *pending, const struct subtitle_mark *candidate,
        uint64_t now, bool *replaced) {
    expire(pending, now);
    bool changed = candidate && (!pending->has_visible ||
        now - pending->last_visible >= SUBTITLE_GAP_MS || !subtitle_same_mark(&pending->visible, candidate));
    if (candidate) {
        pending->has_visible = true;
        pending->visible = *candidate;
        pending->last_visible = now;
    }

    struct ocr_pending_slot *slots = pending->slots;
    int target = 0;
    if (changed) {
        if (slots[0].occupied && slots[0].protected) {
            // If both slots are full, keep the first onset and the freshest transition.
            target = !slots[1].occupied || slots[1].order_at > slots[0].order_at ? 1 : 0;
        }
    } else if ((slots[0].occupied && slots[0].protected) || (slots[1].occupied && slots[1].protected)) {
        return -1;
    }

    *replaced = slots[target].occupied;
    slots[target] = (struct ocr_pending_slot){.captured_at = now, .order_at = now, .occupied = true, .protected = changed};
    return target;
}

int ocr_pending_take(struct ocr_pending *pending, uint64_t now) {
    if (!ocr_pending_waiting(pending, now)) return -1;
    struct ocr_pending_slot *slots = pending->slots;
    int target;
    if (!slots[0].occupied) target = 1;
    else if (!slots[1].occupied) target = 0;
    else if (slots[0].protected != slots[1].protected) target = slots[0].protected ? 0 : 1;
    else if (slots[0].protected) target = slots[1].order_at < slots[0].order_at ? 1 : 0;
    else target = slots[1].captured_at > slots[0].captured_at ? 1 : 0;
    slots[target].occupied = false;
    return target;
}

int ocr_pending_latest(struct ocr_pending *pending, uint64_t now) {
    if (!ocr_pending_waiting(pending, now)) return -1;
    return !pending->slots[0].occupied || (pending->slots[1].occupied &&
        pending->slots[1].order_at > pending->slots[0].order_at) ? 1 : 0;
}

bool ocr_pending_refresh(struct ocr_pending *pending, int index, uint64_t now) {
    // Caller proves identical full crop bytes, dimensions and ROI revision.
    // Coarse candidate marks alone must never merge two different captions.
    if (index < 0 || index >= OCR_PENDING_SLOTS || ocr_pending_latest(pending, now) != index) return false;
    pending->slots[index].captured_at = now;
    pending->refreshed++;
    return true;
}
