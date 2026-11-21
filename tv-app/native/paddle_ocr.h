/* SPDX-License-Identifier: AGPL-3.0-only */
#ifndef GTAVI_PADDLE_OCR_H
#define GTAVI_PADDLE_OCR_H

#include <stdbool.h>
#include <stdint.h>

enum { PADDLE_TEXT_BYTES = 1441 };

struct paddle_ocr;

struct paddle_result {
    char text[PADDLE_TEXT_BYTES];
    int confidence;
};

struct paddle_ocr *paddle_open(const char *runtime);
void paddle_close(struct paddle_ocr *ocr);
bool paddle_read(struct paddle_ocr *ocr, const uint8_t *luma, int width, int height,
    int frame_height, struct paddle_result *result);

#endif
