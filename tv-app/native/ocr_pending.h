/* SPDX-License-Identifier: AGPL-3.0-only */
#ifndef GTAVI_OCR_PENDING_H
#define GTAVI_OCR_PENDING_H

#include "ocr_image.h"

enum { OCR_PENDING_SLOTS = 2 };

struct ocr_pending_slot {
    uint64_t captured_at;
    uint64_t order_at;
    bool occupied;
    bool protected;
};

struct ocr_pending {
    struct ocr_pending_slot slots[OCR_PENDING_SLOTS];
    struct subtitle_mark visible;
    uint64_t last_visible;
    bool has_visible;
    uint64_t expired;
    uint64_t refreshed;
};

bool ocr_pending_waiting(struct ocr_pending *pending, uint64_t now);
int ocr_pending_offer(struct ocr_pending *pending, const struct subtitle_mark *candidate,
    uint64_t now, bool *replaced);
int ocr_pending_take(struct ocr_pending *pending, uint64_t now);
int ocr_pending_latest(struct ocr_pending *pending, uint64_t now);
bool ocr_pending_refresh(struct ocr_pending *pending, int index, uint64_t now);

#endif
