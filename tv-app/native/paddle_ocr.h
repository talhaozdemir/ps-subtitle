/* SPDX-License-Identifier: AGPL-3.0-only */
#ifndef GTAVI_PADDLE_OCR_H
#define GTAVI_PADDLE_OCR_H

#include <stdbool.h>
#include <stdint.h>

enum { PADDLE_TEXT_BYTES = 1441 };
enum { PADDLE_DEFAULT_THREADS = 3 };

struct paddle_ocr;

struct paddle_result {
    char text[PADDLE_TEXT_BYTES];
    int confidence;
};

struct paddle_stats {
    uint64_t detector_runs;
    uint64_t reader_runs;
    uint64_t line_cache_hits;
    int threads;
};

struct paddle_ocr *paddle_open(const char *runtime);
struct paddle_ocr *paddle_open_threads(const char *runtime, int threads);
void paddle_cache_enable(struct paddle_ocr *ocr, bool enabled);
void paddle_stats_read(const struct paddle_ocr *ocr, struct paddle_stats *stats);
void paddle_close(struct paddle_ocr *ocr);
bool paddle_read(struct paddle_ocr *ocr, const uint8_t *luma, int width, int height,
    int frame_height, struct paddle_result *result);

#endif
