/* SPDX-License-Identifier: AGPL-3.0-only */
#ifndef HDMI_JPEG_H
#define HDMI_JPEG_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
enum { HDMI_WIDTH = 960, HDMI_HEIGHT = 540, HDMI_MAX_JPEG = 2 * 1024 * 1024 };
bool hdmi_decode_band(const uint8_t *source, size_t size, int x, int y, int right, int bottom,
        uint8_t *destination);
#endif
