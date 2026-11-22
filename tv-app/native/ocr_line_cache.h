/* SPDX-License-Identifier: AGPL-3.0-only */
#ifndef GTAVI_OCR_LINE_CACHE_H
#define GTAVI_OCR_LINE_CACHE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

enum { OCR_LINE_CACHE_SLOTS = 12, OCR_LINE_CACHE_TEXT = 1441 };

struct ocr_line_entry {
    float *pixels;
    size_t capacity;
    size_t size;
    int width;
    uint64_t used;
    char text[OCR_LINE_CACHE_TEXT];
    int confidence;
};

struct ocr_line_cache {
    struct ocr_line_entry entries[OCR_LINE_CACHE_SLOTS];
    uint64_t clock;
};

bool ocr_line_cache_get(struct ocr_line_cache *cache, const float *pixels, size_t size,
    int width, char *text, size_t capacity, int *confidence);
void ocr_line_cache_put(struct ocr_line_cache *cache, const float *pixels, size_t size,
    int width, const char *text, int confidence);
void ocr_line_cache_clear(struct ocr_line_cache *cache);

#endif
