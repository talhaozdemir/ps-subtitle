/* SPDX-License-Identifier: AGPL-3.0-only */
#include "ocr_line_cache.h"

#include <stdlib.h>
#include <string.h>

bool ocr_line_cache_get(struct ocr_line_cache *cache, const float *pixels, size_t size,
        int width, char *text, size_t capacity, int *confidence) {
    for (int i = 0; i < OCR_LINE_CACHE_SLOTS; i++) {
        struct ocr_line_entry *entry = &cache->entries[i];
        if (!entry->used || entry->width != width || entry->size != size ||
                memcmp(entry->pixels, pixels, size) != 0) continue;
        size_t length = strlen(entry->text);
        if (length >= capacity) return false;
        memcpy(text, entry->text, length + 1);
        *confidence = entry->confidence;
        entry->used = ++cache->clock;
        return true;
    }
    return false;
}

void ocr_line_cache_put(struct ocr_line_cache *cache, const float *pixels, size_t size,
        int width, const char *text, int confidence) {
    if (!size || !text[0] || confidence <= 0 || strlen(text) >= OCR_LINE_CACHE_TEXT) return;
    struct ocr_line_entry *entry = &cache->entries[0];
    for (int i = 0; i < OCR_LINE_CACHE_SLOTS; i++) {
        if (!cache->entries[i].used) { entry = &cache->entries[i]; break; }
        if (cache->entries[i].used < entry->used) entry = &cache->entries[i];
    }
    if (entry->capacity < size) {
        float *buffer = realloc(entry->pixels, size);
        if (!buffer) return; // A cache allocation must never stop live OCR.
        entry->pixels = buffer;
        entry->capacity = size;
    }
    memcpy(entry->pixels, pixels, size);
    entry->size = size;
    entry->width = width;
    memcpy(entry->text, text, strlen(text) + 1);
    entry->confidence = confidence;
    entry->used = ++cache->clock;
}

void ocr_line_cache_clear(struct ocr_line_cache *cache) {
    for (int i = 0; i < OCR_LINE_CACHE_SLOTS; i++) free(cache->entries[i].pixels);
    memset(cache, 0, sizeof(*cache));
}
