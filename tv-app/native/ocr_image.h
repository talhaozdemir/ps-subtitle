/* SPDX-License-Identifier: AGPL-3.0-only */
#ifndef GTAVI_OCR_IMAGE_H
#define GTAVI_OCR_IMAGE_H

#include <stddef.h>
#include <stdbool.h>
#include <stdint.h>

enum { OCR_BORDER = 8 };
enum { SUBTITLE_MARK_COLUMNS = 128, SUBTITLE_MARK_ROWS = 3 };

struct subtitle_search {
    uint8_t *seen;
    uint32_t *queue;
    size_t capacity;
};

struct subtitle_layout {
    int width;
    int height;
    int lines;
    bool boxed;
};

struct subtitle_backdrop {
    const uint8_t *blue;
    int stride;
    int x_phase;
    int y_phase;
};

struct subtitle_mark {
    uint8_t ink[SUBTITLE_MARK_ROWS * SUBTITLE_MARK_COLUMNS];
};

bool subtitle_blue_chroma(uint8_t u, uint8_t v);
struct subtitle_layout subtitle_rectangle(struct subtitle_search *search, const uint8_t *luma,
    int width, int height, int frame_height, const struct subtitle_backdrop *backdrop, uint8_t *mask);
struct subtitle_layout subtitle_focus(struct subtitle_search *search, const uint8_t *luma,
    int width, int height, int frame_height, const struct subtitle_backdrop *backdrop, uint8_t *mask);

struct subtitle_layout subtitle_outline(struct subtitle_search *search, const uint8_t *luma,
    int width, int height, int frame_height, uint8_t *mask);

bool subtitle_candidate(struct subtitle_search *search, const uint8_t *luma, int width,
    int height, int frame_height, uint8_t *mask);
bool subtitle_candidate_mark(struct subtitle_search *search, const uint8_t *luma, int width,
    int height, int frame_height, uint8_t *mask, struct subtitle_mark *mark);
bool subtitle_same_mark(const struct subtitle_mark *first, const struct subtitle_mark *second);

void subtitle_band(int height, int frame_height, int *top, int *bottom);

void subtitle_mask(const uint8_t *luma, int width, int height, int radius, uint8_t *mask);
void subtitle_image(const uint8_t *mask, int width, int height, int scale, uint8_t *image);

#endif
