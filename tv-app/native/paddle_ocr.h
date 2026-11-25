/* SPDX-License-Identifier: AGPL-3.0-only */
#ifndef GTAVI_PADDLE_OCR_H
#define GTAVI_PADDLE_OCR_H

#include <stdbool.h>
#include <stdint.h>

enum { PADDLE_TEXT_BYTES = 1441 };
enum { PADDLE_DEFAULT_THREADS = 3 };
enum { PADDLE_SUBTITLE_LINES = 6, PADDLE_HINT_LINES = 2,
    PADDLE_MAX_LINES = PADDLE_SUBTITLE_LINES + PADDLE_HINT_LINES };

struct paddle_ocr;

struct paddle_result {
    char text[PADDLE_TEXT_BYTES];
    int confidence;
};

struct paddle_line {
    int offset, length, confidence;
    int left, top, right, bottom;
};

struct paddle_lines {
    int count;
    struct paddle_line items[PADDLE_MAX_LINES];
};

struct paddle_area {
    double left, top, right, bottom;
};

struct paddle_regions {
    struct paddle_area dialogue, objective, hint;
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
bool paddle_read_lines(struct paddle_ocr *ocr, const uint8_t *luma, int width, int height,
    int frame_height, struct paddle_result *result, struct paddle_lines *positions,
    const struct paddle_regions *regions);

#endif
