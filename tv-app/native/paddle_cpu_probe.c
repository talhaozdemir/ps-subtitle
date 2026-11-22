/* SPDX-License-Identifier: AGPL-3.0-only */
#define _POSIX_C_SOURCE 200809L
#include "paddle_ocr.h"

#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

struct frame { uint8_t *pixels; uint32_t width, height, frame_height; };

static double now_ms(void) {
    struct timespec value;
    clock_gettime(CLOCK_MONOTONIC, &value);
    return value.tv_sec * 1000.0 + value.tv_nsec / 1000000.0;
}

static void json_text(const char *text) {
    putchar('"');
    for (const unsigned char *at = (const unsigned char *)text; *at; at++) {
        if (*at == '"' || *at == '\\') putchar('\\');
        if (*at < 32) printf("\\u%04x", *at);
        else putchar(*at);
    }
    putchar('"');
}

int main(int argc, char **argv) {
    if (argc != 5) return 2;
    int threads = atoi(argv[3]), repeats = atoi(argv[4]);
    if (threads < 1 || threads > 3 || repeats < 1 || repeats > 10) return 2;
    FILE *input = fopen(argv[2], "rb");
    uint32_t count = 0;
    struct frame frames[32] = {0};
    if (!input || fread(&count, sizeof(count), 1, input) != 1 || !count || count > 32) return 3;
    for (uint32_t i = 0; i < count; i++) {
        uint32_t shape[3];
        if (fread(shape, sizeof(shape), 1, input) != 1 || shape[0] < 12 || shape[0] > 1920 ||
                shape[1] < 6 || shape[1] > 1080 || shape[2] < 80 || shape[2] > 1080) return 3;
        frames[i].width = shape[0]; frames[i].height = shape[1]; frames[i].frame_height = shape[2];
        size_t size = (size_t)shape[0] * shape[1];
        frames[i].pixels = malloc(size);
        if (!frames[i].pixels || fread(frames[i].pixels, 1, size, input) != size) return 3;
    }
    fclose(input);
    struct paddle_ocr *ocr = paddle_open_threads(argv[1], threads);
    if (!ocr) return 4;
    paddle_cache_enable(ocr, false);
    struct paddle_result result;
    for (uint32_t i = 0; i < count && i < 2; i++)
        if (!paddle_read(ocr, frames[i].pixels, (int)frames[i].width, (int)frames[i].height,
                (int)frames[i].frame_height, &result)) return 5;
    for (int repeat = 0; repeat < repeats; repeat++) {
        for (uint32_t order = 0; order < count; order++) {
            uint32_t i = repeat % 2 ? count - order - 1 : order;
            struct frame *frame = &frames[i];
            double started = now_ms();
            if (!paddle_read(ocr, frame->pixels, (int)frame->width, (int)frame->height,
                    (int)frame->frame_height, &result)) return 5;
            double elapsed = now_ms() - started;
            printf("{\"threads\":%d,\"repeat\":%d,\"frame\":%u,\"ms\":%.3f,\"confidence\":%d,\"text\":",
                threads, repeat, i, elapsed, result.confidence);
            json_text(result.text);
            puts("}");
            fflush(stdout);
        }
    }
    struct paddle_stats stats;
    paddle_stats_read(ocr, &stats);
    printf("{\"threads\":%d,\"readerRuns\":%" PRIu64 ",\"lineCacheHits\":%" PRIu64 "}\n",
        threads, stats.reader_runs, stats.line_cache_hits);
    fflush(stdout);
    // This is a one-shot measurement process. Some ARM ORT builds reenter
    // global schema teardown on dlclose; let the OS reclaim this process's
    // memory instead. Production session lifetime is unchanged.
    _Exit(0);
}
