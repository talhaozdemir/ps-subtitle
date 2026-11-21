/* SPDX-License-Identifier: AGPL-3.0-only */
#include "ocr_pending.h"

enum { PENDING_MAX_AGE_MS = 1500, SUBTITLE_GAP_MS = 380 };

static void expire(struct ocr_pending *pending, uint64_t now) {
    for (int index = 0; index < OCR_PENDING_SLOTS; index++) {
        struct ocr_pending_slot *slot = &pending->slots[index];
        if (slot->occupied && slot->protected && now - slot->captured_at > PENDING_MAX_AGE_MS)
            slot->occupied = false;
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
            target = !slots[1].occupied || slots[1].captured_at > slots[0].captured_at ? 1 : 0;
        }
    } else if ((slots[0].occupied && slots[0].protected) || (slots[1].occupied && slots[1].protected)) {
        return -1;
    }

    *replaced = slots[target].occupied;
    slots[target] = (struct ocr_pending_slot){.captured_at = now, .occupied = true, .protected = changed};
    return target;
}

int ocr_pending_take(struct ocr_pending *pending, uint64_t now) {
    if (!ocr_pending_waiting(pending, now)) return -1;
    struct ocr_pending_slot *slots = pending->slots;
    int target = !slots[0].occupied ||
        (slots[1].occupied && slots[1].captured_at < slots[0].captured_at) ? 1 : 0;
    slots[target].occupied = false;
    return target;
}
