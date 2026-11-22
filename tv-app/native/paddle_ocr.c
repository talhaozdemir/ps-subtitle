/* SPDX-License-Identifier: AGPL-3.0-only */
#include "paddle_ocr.h"

#include <math.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
#else
#include <dlfcn.h>
#endif
#include <onnxruntime_c_api.h>

enum { DETECTOR_LIMIT = 512, LINE_HEIGHT = 48, MAX_BOXES = 16, MAX_LINES = 6,
    MAX_CHARACTERS = 18710, MAX_MODEL_BYTES = 32 * 1024 * 1024 };

struct box {
    int left, top, right, bottom;
};

struct paddle_ocr {
#ifdef _WIN32
    HMODULE library;
#else
    void *library;
#endif
    const OrtApi *api;
    OrtEnv *env;
    OrtSession *detector;
    OrtSession *reader;
    OrtMemoryInfo *memory;
    char *dictionary;
    const char *characters[MAX_CHARACTERS];
    int character_count;
    float *input;
    size_t input_capacity;
    uint8_t *foreground;
    int *queue;
    size_t mask_capacity;
};

static int minimum(int a, int b) { return a < b ? a : b; }
static int maximum(int a, int b) { return a > b ? a : b; }

static bool check(const OrtApi *api, OrtStatus *status) {
    if (!status) return true;
    fprintf(stderr, "PaddleOCR: %s\n", api->GetErrorMessage(status));
    api->ReleaseStatus(status);
    return false;
}

static bool reserve_input(struct paddle_ocr *ocr, size_t pixels) {
    if (pixels <= ocr->input_capacity) return true;
    float *input = realloc(ocr->input, 3 * pixels * sizeof(*input));
    if (!input) return false;
    ocr->input = input;
    ocr->input_capacity = pixels;
    return true;
}

static bool reserve_mask(struct paddle_ocr *ocr, size_t pixels) {
    if (pixels <= ocr->mask_capacity) return true;
    uint8_t *foreground = realloc(ocr->foreground, pixels);
    if (!foreground) return false;
    ocr->foreground = foreground;
    int *queue = realloc(ocr->queue, pixels * sizeof(*queue));
    if (!queue) return false;
    ocr->queue = queue;
    ocr->mask_capacity = pixels;
    return true;
}

static char *read_file(const char *path, size_t limit, size_t *bytes) {
    FILE *file = fopen(path, "rb");
    if (!file) return NULL;
    char *contents = NULL;
    if (!fseek(file, 0, SEEK_END)) {
        long length = ftell(file);
        if (length > 0 && (unsigned long)length <= limit && !fseek(file, 0, SEEK_SET)) {
            contents = malloc((size_t)length + 1);
            if (contents && fread(contents, 1, (size_t)length, file) == (size_t)length) {
                *bytes = (size_t)length;
                contents[length] = '\0';
            } else {
                free(contents);
                contents = NULL;
            }
        }
    }
    fclose(file);
    return contents;
}

static bool open_session(struct paddle_ocr *ocr, OrtSessionOptions *options, const char *path,
        OrtSession **session) {
    size_t size;
    char *model = read_file(path, MAX_MODEL_BYTES, &size);
    if (!model) return false;
    bool loaded = check(ocr->api, ocr->api->CreateSessionFromArray(ocr->env, model, size, options, session));
    free(model);
    return loaded;
}

static bool load_dictionary(struct paddle_ocr *ocr, const char *path) {
    size_t size;
    ocr->dictionary = read_file(path, 1024 * 1024, &size);
    if (!ocr->dictionary) return false;
    ocr->characters[0] = "";
    int index = 1;
    char *start = ocr->dictionary;
    for (size_t i = 0; i < size; i++) {
        if (ocr->dictionary[i] != '\0') continue;
        if (index >= MAX_CHARACTERS || start == &ocr->dictionary[i]) return false;
        ocr->characters[index++] = start;
        start = &ocr->dictionary[i + 1];
    }
    ocr->character_count = index;
    return index > 1 && start == ocr->dictionary + size;
}

struct paddle_ocr *paddle_open(const char *runtime) {
    struct paddle_ocr *ocr = calloc(1, sizeof(*ocr));
    if (!ocr) return NULL;
    OrtSessionOptions *options = NULL;
    char path[4096];
#ifdef _WIN32
    snprintf(path, sizeof(path), "%s/lib/onnxruntime.dll", runtime);
    ocr->library = LoadLibraryA(path);
    if (!ocr->library) goto fail;
    const OrtApiBase *(ORT_API_CALL *get_api)(void) =
        (const OrtApiBase *(ORT_API_CALL *)(void))GetProcAddress(ocr->library, "OrtGetApiBase");
#else
    snprintf(path, sizeof(path), "%s/lib/libonnxruntime.so.1.21", runtime);
    ocr->library = dlopen(path, RTLD_NOW | RTLD_LOCAL);
    if (!ocr->library) {
        fprintf(stderr, "PaddleOCR: %s\n", dlerror());
        goto fail;
    }
    const OrtApiBase *(*get_api)(void) = (const OrtApiBase *(*)(void))dlsym(ocr->library, "OrtGetApiBase");
#endif
    if (!get_api) goto fail;
    const OrtApi *api = get_api()->GetApi(ORT_API_VERSION);
    if (!api) goto fail;
    ocr->api = api;
    if (!check(api, api->CreateEnv(ORT_LOGGING_LEVEL_ERROR, "ps-subtitle", &ocr->env)) ||
        !check(api, api->CreateSessionOptions(&options)) ||
        !check(api, api->SetIntraOpNumThreads(options, 3)) ||
        !check(api, api->SetInterOpNumThreads(options, 1)) ||
        !check(api, api->AddSessionConfigEntry(options, "session.intra_op.allow_spinning", "0")) ||
        !check(api, api->SetSessionGraphOptimizationLevel(options, ORT_ENABLE_ALL)) ||
        !check(api, api->CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault, &ocr->memory))) goto fail;

    snprintf(path, sizeof(path), "%s/paddle/det.onnx", runtime);
    if (!open_session(ocr, options, path, &ocr->detector)) goto fail;
    snprintf(path, sizeof(path), "%s/paddle/rec.onnx", runtime);
    if (!open_session(ocr, options, path, &ocr->reader)) goto fail;
    snprintf(path, sizeof(path), "%s/paddle/characters.bin", runtime);
    if (!load_dictionary(ocr, path)) goto fail;
    api->ReleaseSessionOptions(options);
    return ocr;

fail:
    if (options) ocr->api->ReleaseSessionOptions(options);
    paddle_close(ocr);
    return NULL;
}

void paddle_close(struct paddle_ocr *ocr) {
    if (!ocr) return;
    if (ocr->api) {
        ocr->api->ReleaseSession(ocr->reader);
        ocr->api->ReleaseSession(ocr->detector);
        ocr->api->ReleaseMemoryInfo(ocr->memory);
        ocr->api->ReleaseEnv(ocr->env);
    }
#ifdef _WIN32
    if (ocr->library) FreeLibrary(ocr->library);
#else
    if (ocr->library) dlclose(ocr->library);
#endif
    free(ocr->queue);
    free(ocr->foreground);
    free(ocr->dictionary);
    free(ocr->input);
    free(ocr);
}

static bool run(struct paddle_ocr *ocr, OrtSession *session, int height, int width,
        OrtValue **output, int64_t *dims, size_t rank) {
    const OrtApi *api = ocr->api;
    int64_t shape[] = {1, 3, height, width};
    OrtValue *input = NULL;
    OrtTensorTypeAndShapeInfo *info = NULL;
    size_t actual = 0;
    const char *input_name = "x", *output_name = "fetch_name_0";
    bool ok = check(api, api->CreateTensorWithDataAsOrtValue(ocr->memory, ocr->input,
        (size_t)height * width * 3 * sizeof(*ocr->input), shape, 4, ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &input));
    const OrtValue *arguments[] = {input};
    ok = ok && check(api, api->Run(session, NULL, &input_name, arguments, 1, &output_name, 1, output)) &&
        check(api, api->GetTensorTypeAndShape(*output, &info)) &&
        check(api, api->GetDimensionsCount(info, &actual)) && actual == rank &&
        check(api, api->GetDimensions(info, dims, rank));
    api->ReleaseTensorTypeAndShapeInfo(info);
    api->ReleaseValue(input);
    return ok;
}

static float sample(const uint8_t *luma, int stride, struct box area, float x, float y) {
    float px = fminf(fmaxf(x, (float)area.left), (float)(area.right - 1));
    float py = fminf(fmaxf(y, (float)area.top), (float)(area.bottom - 1));
    int left = (int)px, top = (int)py;
    int right = minimum(left + 1, area.right - 1), bottom = minimum(top + 1, area.bottom - 1);
    float fx = px - left, fy = py - top;
    float a = luma[(size_t)top * stride + left] * (1 - fx) + luma[(size_t)top * stride + right] * fx;
    float b = luma[(size_t)bottom * stride + left] * (1 - fx) + luma[(size_t)bottom * stride + right] * fx;
    return a * (1 - fy) + b * fy;
}

static void prepare_input(float *tensor, const uint8_t *luma, int stride, struct box area,
        int width, int height, int content_width, bool detection) {
    static const float mean[] = {.485f, .456f, .406f};
    static const float deviation[] = {.229f, .224f, .225f};
    size_t pixels = (size_t)width * height;
    if (content_width < width) memset(tensor, 0, 3 * pixels * sizeof(*tensor));
    float scale_x = (float)(area.right - area.left) / content_width;
    float scale_y = (float)(area.bottom - area.top) / height;
    for (int row = 0; row < height; row++) {
        float y = area.top + (row + .5f) * scale_y - .5f;
        for (int col = 0; col < content_width; col++) {
            float x = area.left + (col + .5f) * scale_x - .5f;
            float shade = sample(luma, stride, area, x, y) / 255.0f;
            size_t position = (size_t)row * width + col;
            for (int channel = 0; channel < 3; channel++) {
                tensor[position + (size_t)channel * pixels] = detection ?
                    (shade - mean[channel]) / deviation[channel] : shade * 2 - 1;
            }
        }
    }
}

static struct box component(struct paddle_ocr *ocr, int width, int height, int first) {
    struct box area = {width, height, 0, 0};
    int size = 1;
    ocr->queue[0] = first;
    ocr->foreground[first] = 0;
    for (int index = 0; index < size; index++) {
        int point = ocr->queue[index], x = point % width, y = point / width;
        area.left = minimum(area.left, x);
        area.right = maximum(area.right, x + 1);
        area.top = minimum(area.top, y);
        area.bottom = maximum(area.bottom, y + 1);
        for (int row = maximum(y - 1, 0); row <= minimum(y + 1, height - 1); row++) {
            for (int col = maximum(x - 1, 0); col <= minimum(x + 1, width - 1); col++) {
                int next = row * width + col;
                if (!ocr->foreground[next]) continue;
                ocr->foreground[next] = 0;
                ocr->queue[size++] = next;
            }
        }
    }
    return area;
}

static size_t find_boxes(struct paddle_ocr *ocr, const float *map, int width, int height,
        int original_width, int original_height, int frame_height, struct box *boxes) {
    for (int row = 0; row < height; row++) {
        for (int col = 0; col < width; col++) {
            int here = row * width + col;
            ocr->foreground[here] = map[here] > .30f ||
                (col && map[here - 1] > .30f) || (row && map[here - width] > .30f) ||
                (col && row && map[here - width - 1] > .30f);
        }
    }

    size_t count = 0;
    for (int first = 0; first < width * height; first++) {
        if (!ocr->foreground[first]) continue;
        struct box area = component(ocr, width, height, first);
        int w = area.right - area.left, h = area.bottom - area.top;
        if (w < 4 || h < 4) continue;
        double sum = 0;
        for (int y = area.top; y < area.bottom; y++)
            for (int x = area.left; x < area.right; x++) sum += map[y * width + x];
        float score = (float)(sum / ((size_t)w * h));
        if (score < .50f) continue;
        w--;
        h--;
        float padding = .8f * w * h / (w + h);
        float sx = (float)original_width / width, sy = (float)original_height / height;
        area.right = minimum(original_width, (int)lroundf((area.left + w + padding) * sx));
        area.bottom = minimum(original_height, (int)lroundf((area.top + h + padding) * sy));
        area.left = maximum(0, (int)lroundf((area.left - padding) * sx));
        area.top = maximum(0, (int)lroundf((area.top - padding) * sy));
        int text_width = area.right - area.left, text_height = area.bottom - area.top;
        if (text_width < 5 || text_height < 5 || text_height > maximum(20, frame_height / 10) ||
            abs(area.left + area.right - original_width) > original_width / 3) continue;
        if (count < MAX_BOXES) boxes[count++] = area;
    }
    return count;
}

static int by_position(const void *first, const void *second) {
    const struct box *a = first, *b = second;
    return a->top == b->top ? a->left - b->left : a->top - b->top;
}

static bool recognize(struct paddle_ocr *ocr, const uint8_t *luma, int stride, struct box box,
        char *text, size_t capacity, int *confidence) {
    int content_width = minimum(1536, (int)ceilf((float)LINE_HEIGHT * (box.right - box.left) / (box.bottom - box.top)));
    int width = maximum(32, (content_width + 7) / 8 * 8);
    if (!reserve_input(ocr, (size_t)width * LINE_HEIGHT)) return false;
    prepare_input(ocr->input, luma, stride, box, width, LINE_HEIGHT, content_width, false);
    OrtValue *output = NULL;
    int64_t dims[3];
    void *data = NULL;
    bool ok = run(ocr, ocr->reader, LINE_HEIGHT, width, &output, dims, 3);
    ok = ok && dims[0] == 1 && dims[1] > 0 && dims[1] <= width && dims[2] == ocr->character_count &&
        check(ocr->api, ocr->api->GetTensorMutableData(output, &data));
    *confidence = 0;
    if (ok) {
        const float *probabilities = data;
        int previous = 0, predicted = 0, letters = 0;
        float score = 0;
        size_t length = 0;
        for (int64_t step = 0; step < dims[1]; step++) {
            int best = 0;
            for (int character = 1; character < ocr->character_count; character++) {
                if (probabilities[character] > probabilities[best]) best = character;
            }
            if (best && best != previous) {
                const char *character = ocr->characters[best];
                size_t bytes = strlen(character);
                if (bytes >= capacity - length) break;
                memcpy(text + length, character, bytes);
                length += bytes;
                letters += (character[0] >= 'A' && character[0] <= 'Z') ||
                    (character[0] >= 'a' && character[0] <= 'z');
                predicted++;
                score += probabilities[best];
            }
            previous = best;
            probabilities += ocr->character_count;
        }
        if (predicted && (letters >= 2 || (letters == 1 && length == 1 &&
                (text[0] == 'I' || text[0] == 'A'))) && score / predicted >= .55f) {
            text[length] = '\0';
            *confidence = (int)lroundf(100 * score / predicted);
        } else {
            text[0] = '\0';
        }
    }
    ocr->api->ReleaseValue(output);
    return ok;
}

bool paddle_read(struct paddle_ocr *ocr, const uint8_t *luma, int width, int height,
        int frame_height, struct paddle_result *result) {
    *result = (struct paddle_result){0};
    if (width < 12 || height < 6) return true;
    int longest = maximum(width, height);
    float scale = fminf(1.0f, (float)DETECTOR_LIMIT / longest);
    int map_width = maximum(32, (int)lroundf(width * scale / 32) * 32);
    int map_height = maximum(32, (int)lroundf(height * scale / 32) * 32);
    size_t pixels = (size_t)map_width * map_height;
    if (!reserve_input(ocr, pixels) || !reserve_mask(ocr, pixels)) return false;
    struct box full = {0, 0, width, height};
    prepare_input(ocr->input, luma, width, full, map_width, map_height, map_width, true);
    OrtValue *output = NULL;
    int64_t dims[4];
    void *data = NULL;
    bool ok = run(ocr, ocr->detector, map_height, map_width, &output, dims, 4);
    ok = ok && dims[0] == 1 && dims[1] == 1 && dims[2] == map_height && dims[3] == map_width &&
        check(ocr->api, ocr->api->GetTensorMutableData(output, &data));
    struct box boxes[MAX_BOXES];
    size_t count = ok ? find_boxes(ocr, data, map_width, map_height, width, height, frame_height, boxes) : 0;
    ocr->api->ReleaseValue(output);
    if (!ok) return false;
    qsort(boxes, count, sizeof(*boxes), by_position);

    size_t length = 0;
    int lines = 0, confidence_sum = 0;
    for (size_t index = 0; index < count && lines < MAX_LINES; index++) {
        char line[PADDLE_TEXT_BYTES];
        int confidence;
        if (!recognize(ocr, luma, width, boxes[index], line, sizeof(line), &confidence)) return false;
        if (!confidence) continue;
        size_t line_length = strlen(line);
        if (line_length + (lines != 0) >= sizeof(result->text) - length) break;
        if (lines) result->text[length++] = '\n';
        memcpy(result->text + length, line, line_length + 1);
        length += line_length;
        lines++;
        confidence_sum += confidence;
    }
    if (lines) result->confidence = confidence_sum / lines;
    return true;
}
