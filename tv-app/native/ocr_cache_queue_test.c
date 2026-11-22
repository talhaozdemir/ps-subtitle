/* SPDX-License-Identifier: AGPL-3.0-only */
#include "ocr_line_cache.h"
#include "ocr_pending.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static void cache_inputs(void) {
    struct ocr_line_cache cache = {0};
    const float first[] = {-1, .125f, .25f, 1};
    float changed[] = {-1, .125f, .25f, 1};
    char text[1441];
    int confidence = 0;
    assert(!ocr_line_cache_get(&cache, first, sizeof(first), 4, text, sizeof(text), &confidence));
    ocr_line_cache_put(&cache, first, sizeof(first), 4, "Keep the door open.", 97);
    assert(ocr_line_cache_get(&cache, first, sizeof(first), 4, text, sizeof(text), &confidence));
    assert(strcmp(text, "Keep the door open.") == 0 && confidence == 97);
    // Even a one-bit input change must cause fresh recognition.
    ((unsigned char *)changed)[sizeof(float)] ^= 1;
    assert(!ocr_line_cache_get(&cache, changed, sizeof(changed), 4, text, sizeof(text), &confidence));
    assert(!ocr_line_cache_get(&cache, first, sizeof(first), 2, text, sizeof(text), &confidence));
    assert(!ocr_line_cache_get(&cache, first, sizeof(first), 4, text, 2, &confidence));
    ocr_line_cache_clear(&cache);
    assert(!ocr_line_cache_get(&cache, first, sizeof(first), 4, text, sizeof(text), &confidence));
}

static void cache_eviction(void) {
    struct ocr_line_cache cache = {0};
    char text[1441];
    int confidence;
    for (int i = 0; i < OCR_LINE_CACHE_SLOTS; i++) {
        float image = (float)i;
        ocr_line_cache_put(&cache, &image, sizeof(image), 1, "A complete line.", 99);
    }
    float first = 0, second = 1, extra = 99;
    assert(ocr_line_cache_get(&cache, &first, sizeof(first), 1, text, sizeof(text), &confidence));
    ocr_line_cache_put(&cache, &extra, sizeof(extra), 1, "A new line.", 99);
    assert(ocr_line_cache_get(&cache, &first, sizeof(first), 1, text, sizeof(text), &confidence));
    assert(!ocr_line_cache_get(&cache, &second, sizeof(second), 1, text, sizeof(text), &confidence));
    ocr_line_cache_clear(&cache);
}

static struct subtitle_mark mark(int offset) {
    struct subtitle_mark value = {0};
    for (int i = offset; i < offset + 20; i++) value.ink[i] = 10;
    return value;
}

static void queue_onsets(void) {
    struct ocr_pending queue = {0};
    struct subtitle_mark a = mark(0), b = mark(40), c = mark(80);
    bool replaced;
    int first = ocr_pending_offer(&queue, &a, 100, &replaced);
    assert(first == 0 && !replaced);
    int second = ocr_pending_offer(&queue, &b, 200, &replaced);
    assert(second == 1 && !replaced);
    assert(!ocr_pending_refresh(&queue, first, 300));
    assert(ocr_pending_refresh(&queue, second, 300));
    assert(queue.slots[second].order_at == 200 && queue.slots[second].captured_at == 300);
    assert(ocr_pending_take(&queue, 400) == first);
    assert(ocr_pending_take(&queue, 401) == second);
    assert(queue.refreshed == 1);
    // With capacity two, preserve first onset and latest distinct transition.
    first = ocr_pending_offer(&queue, &a, 500, &replaced);
    second = ocr_pending_offer(&queue, &b, 600, &replaced);
    assert(ocr_pending_offer(&queue, &c, 700, &replaced) == second && replaced);
    assert(ocr_pending_take(&queue, 800) == first);
    assert(ocr_pending_take(&queue, 801) == second);
}

static void queue_age(void) {
    struct ocr_pending queue = {0};
    struct subtitle_mark a = mark(0);
    bool replaced;
    ocr_pending_offer(&queue, NULL, 100, &replaced);
    assert(ocr_pending_take(&queue, 1601) == -1); // Old background frames also expire.
    assert(queue.expired == 1);
    int index = ocr_pending_offer(&queue, &a, 1700, &replaced);
    assert(ocr_pending_refresh(&queue, index, 2200));
    assert(ocr_pending_take(&queue, 3201) == index); // The identical source is fresh.
    index = ocr_pending_offer(&queue, &a, 3300, &replaced);
    assert(!ocr_pending_refresh(&queue, index, 4801)); // No resurrection after expiry.
    assert(queue.expired == 2);
    // A pending subtitle outranks an older unprotected background image.
    queue.slots[0] = (struct ocr_pending_slot){.occupied = true, .captured_at = 5000, .order_at = 5000};
    queue.slots[1] = (struct ocr_pending_slot){.occupied = true, .protected = true, .captured_at = 5100, .order_at = 5100};
    assert(ocr_pending_take(&queue, 5200) == 1);
}

int main(void) {
    cache_inputs();
    cache_eviction();
    queue_onsets();
    queue_age();
    puts("Cache/queue tests passed: exact tensor identity, LRU, fresh duplicate coalescing, onset order and stale backgrounds.");
    return 0;
}
