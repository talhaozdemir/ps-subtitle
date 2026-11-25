/* SPDX-License-Identifier: AGPL-3.0-only */
#define _DEFAULT_SOURCE
#define _POSIX_C_SOURCE 200809L

#include <arpa/inet.h>
#include <errno.h>
#include <ifaddrs.h>
#include <limits.h>
#include <net/if.h>
#include <poll.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include <chiaki/discoveryservice.h>
#include <chiaki/regist.h>
#include <chiaki/session.h>
#include <json-c/json.h>
#include <wels/codec_api.h>

#include "ocr_image.h"
#include "ocr_pending.h"
#include "paddle_ocr.h"
#ifdef HDMI_ONLY
#include "hdmi_jpeg.h"
#endif

enum { QUEUE_SIZE = 12, MAX_WIDTH = 1920, MAX_HEIGHT = 1080 };
enum { DEFAULT_OCR_RATE = 3, BACKGROUND_PROBE_MS = 1000 };
enum { CAPTURE_MAX_FRAMES = 12, CAPTURE_INTERVAL_MS = 450 };

struct region {
    int x;
    int y;
    int width;
    int height;
    int revision;
};

static const struct region default_region = { .x = 6, .y = 67, .width = 88, .height = 26 };

struct packet {
    uint8_t *bytes;
    size_t size;
};

struct crop {
    uint8_t *pixels;
    size_t capacity;
    int width;
    int height;
    int left;
    int top;
    int frame_width;
    int frame_height;
    struct paddle_regions regions;
    bool has_regions;
    int revision;
    bool candidate;
    uint64_t captured_at;
};

struct sample_capture {
    char directory[48];
    unsigned int requested, saved;
    uint64_t next_sample;
};

struct engine {
    ChiakiSession session;
    ChiakiLog log;
    ISVCDecoder *decoder;
    struct paddle_ocr *ocr;
    pthread_mutex_t mutex;
    pthread_cond_t packet_ready;
    pthread_cond_t crop_ready;
    struct packet packets[QUEUE_SIZE];
    size_t head;
    size_t count;
    struct region region;
    struct region dialogue_region;
    struct region objective_region;
    struct region hint_region;
    struct crop crops[OCR_PENDING_SLOTS];
    struct ocr_pending pending;
    atomic_bool done;
    atomic_bool registered;
    atomic_bool video_connected;
    atomic_uint last_crop_ms;
    atomic_uint video_samples;
    atomic_uint dropped_samples;
    atomic_uint decoded_frames;
    atomic_uint sampled_crops;
    atomic_uint replaced_crops;
    atomic_uint ocr_runs;
    atomic_uint skipped_crops;
    atomic_uint capture_requested;
    atomic_uint crop_interval_ms;
    atomic_uint frame_size;
};

static uint64_t milliseconds(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000;
}

static void emit(struct json_object *value) {
    flockfile(stdout);
    fputs(json_object_to_json_string_ext(value, JSON_C_TO_STRING_PLAIN), stdout);
    fputc('\n', stdout);
    fflush(stdout);
    funlockfile(stdout);
    json_object_put(value);
}

static struct json_object *event(const char *type) {
    struct json_object *value = json_object_new_object();
    json_object_object_add(value, "type", json_object_new_string(type));
    return value;
}

static void message(const char *type, const char *text) {
    struct json_object *value = event(type);
    json_object_object_add(value, "text", json_object_new_string(text));
    emit(value);
}

static const char *field(struct json_object *input, const char *name) {
    struct json_object *value;
    if (!json_object_object_get_ex(input, name, &value) ||
        json_object_get_type(value) != json_type_string) return "";
    return json_object_get_string(value);
}

static int nonnegative_int(struct json_object *input, const char *name) {
    struct json_object *value;
    if (!json_object_object_get_ex(input, name, &value) || !json_object_is_type(value, json_type_int))
        return -1;
    int64_t number = json_object_get_int64(value);
    return number >= 0 && number <= INT_MAX ? (int)number : -1;
}

static unsigned int ocr_interval(int rate) {
    if (rate < 1 || rate > 10) rate = DEFAULT_OCR_RATE;
    return (unsigned int)((1000 + rate / 2) / rate);
}

static bool parse_region(struct json_object *input, const char *name, int minimum_height, struct region *region) {
    struct json_object *rectangle;
    if (!json_object_object_get_ex(input, name, &rectangle) ||
        !json_object_is_type(rectangle, json_type_object))
        return false;
    struct region next = {
        .x = nonnegative_int(rectangle, "x"),
        .y = nonnegative_int(rectangle, "y"),
        .width = nonnegative_int(rectangle, "width"),
        .height = nonnegative_int(rectangle, "height"),
        .revision = nonnegative_int(input, "revision"),
    };
    if (next.width < 10 || next.height < minimum_height || next.revision < 0 ||
        next.x < 0 || next.y < 0 || next.x > 100 - next.width || next.y > 100 - next.height)
        return false;
    *region = next;
    return true;
}

static void parse_text_regions(struct engine *engine, struct json_object *input) {
    engine->dialogue_region = engine->region;
    engine->objective_region = (struct region){0};
    engine->hint_region = (struct region){0};
    parse_region(input, "dialogueRegion", 5, &engine->dialogue_region);
    parse_region(input, "objectiveRegion", 3, &engine->objective_region);
    parse_region(input, "hintRegion", 3, &engine->hint_region);
}

static void apply_stream_control(struct engine *engine, const char *line) {
    struct json_object *command = json_tokener_parse(line);
    struct region next;
    if (command && parse_region(command, "region", 5, &next)) {
        pthread_mutex_lock(&engine->mutex);
        if (next.revision > engine->region.revision) {
            engine->region = next;
            parse_text_regions(engine, command);
            engine->pending = (struct ocr_pending){0};
        }
        pthread_mutex_unlock(&engine->mutex);
    }
    if (command) {
        int rate = nonnegative_int(command, "ocrRate");
        if (rate >= 1 && rate <= 10) atomic_store(&engine->crop_interval_ms, ocr_interval(rate));
        int frames = nonnegative_int(command, "captureFrames");
        if (frames > 0 && frames <= CAPTURE_MAX_FRAMES) atomic_store(&engine->capture_requested, (unsigned int)frames);
        json_object_put(command);
    }
}

static bool receive_stream_control(struct engine *engine) {
    struct pollfd input = { .fd = STDIN_FILENO, .events = POLLIN };
    int result = poll(&input, 1, 100);
    if (result <= 0) return result == 0 || errno == EINTR;
    if (!(input.revents & POLLIN)) return false;
    char line[512];
    if (!fgets(line, sizeof(line), stdin)) return false;
    apply_stream_control(engine, line);
    return true;
}

static bool from_hex(const char *input, uint8_t *result, size_t size) {
    if (strlen(input) != size * 2) return false;
    const char digits[] = "0123456789abcdef";
    for (size_t index = 0; index < size; index++) {
        const char *upper = strchr(digits, input[index * 2]);
        const char *lower = strchr(digits, input[index * 2 + 1]);
        if (!upper || !lower) return false;
        result[index] = (uint8_t)(((upper - digits) << 4) | (lower - digits));
    }
    return true;
}

static void add_hex(struct json_object *value, const char *name, const uint8_t *bytes, size_t size) {
    char text[65];
    const char digits[] = "0123456789abcdef";
    if (size * 2 >= sizeof(text)) return;
    for (size_t index = 0; index < size; index++) {
        text[index * 2] = digits[bytes[index] >> 4];
        text[index * 2 + 1] = digits[bytes[index] & 15];
    }
    text[size * 2] = '\0';
    json_object_object_add(value, name, json_object_new_string(text));
}

static void registration_event(ChiakiRegistEvent *result, void *context) {
    struct engine *engine = context;
    if (result->type == CHIAKI_REGIST_EVENT_TYPE_FINISHED_SUCCESS && result->registered_host) {
        const ChiakiRegisteredHost *host = result->registered_host;
        struct json_object *value = event("paired");
        add_hex(value, "registKey", (const uint8_t *)host->rp_regist_key, sizeof(host->rp_regist_key));
        add_hex(value, "rpKey", host->rp_key, sizeof(host->rp_key));
        add_hex(value, "consoleId", host->server_mac, sizeof(host->server_mac));
        emit(value);
    } else {
        message("error", "PS5 eşleştirmeyi kabul etmedi. İkinci hesabı, IP adresini ve yeni eşleştirme kodunu kontrol et.");
    }
    atomic_store(&engine->registered, true);
}

static bool stdin_closed(int wait_ms) {
    struct pollfd input = { .fd = STDIN_FILENO, .events = POLLIN };
    return poll(&input, 1, wait_ms) > 0 && input.revents != 0;
}

static size_t interface_broadcasts(struct sockaddr_storage *addresses, size_t capacity) {
    struct ifaddrs *interfaces;
    if (getifaddrs(&interfaces) != 0) return 0;
    size_t count = 0;
    for (const struct ifaddrs *it = interfaces; it && count < capacity; it = it->ifa_next) {
        if (!it->ifa_addr || it->ifa_addr->sa_family != AF_INET || !it->ifa_broadaddr ||
            !(it->ifa_flags & IFF_UP) || !(it->ifa_flags & IFF_BROADCAST) || (it->ifa_flags & IFF_LOOPBACK)) continue;
        const struct sockaddr_in *broadcast = (const struct sockaddr_in *)it->ifa_broadaddr;
        if (broadcast->sin_addr.s_addr == INADDR_ANY || broadcast->sin_addr.s_addr == INADDR_BROADCAST) continue;
        memcpy(&addresses[count++], broadcast, sizeof(*broadcast));
    }
    freeifaddrs(interfaces);
    return count;
}

static void discovered_hosts(ChiakiDiscoveryHost *hosts, size_t count, void *context) {
    struct json_object **consoles = context;
    struct json_object *list = json_object_new_array();
    for (size_t i = 0; i < count; i++) {
        ChiakiDiscoveryHost *host = &hosts[i];
        struct in_addr ip;
        if (!chiaki_discovery_host_is_ps5(host) || host->state == CHIAKI_DISCOVERY_HOST_STATE_UNKNOWN ||
            !host->host_addr || inet_pton(AF_INET, host->host_addr, &ip) != 1 ||
            !host->host_id || strlen(host->host_id) != 12 ||
            strspn(host->host_id, "0123456789abcdefABCDEF") != 12) continue;
        const char *name = host->host_name ? host->host_name : "";
        struct json_object *console = json_object_new_object();
        json_object_object_add(console, "id", json_object_new_string(host->host_id));
        json_object_object_add(console, "address", json_object_new_string(host->host_addr));
        json_object_object_add(console, "name", json_object_new_string_len(name, strnlen(name, 60)));
        json_object_object_add(console, "ready", json_object_new_boolean(host->state == CHIAKI_DISCOVERY_HOST_STATE_READY));
        json_object_array_add(list, console);
    }
    json_object_put(*consoles);
    *consoles = list;
}

static int discover_consoles(void) {
    ChiakiLog log;
    chiaki_log_init(&log, 0, NULL, NULL);
    struct sockaddr_in all = { .sin_family = AF_INET, .sin_addr = { .s_addr = INADDR_BROADCAST } };
    struct sockaddr_storage target = { 0 };
    memcpy(&target, &all, sizeof(all));
    struct sockaddr_storage broadcasts[8] = { 0 };
    struct json_object *consoles = json_object_new_array();
    ChiakiDiscoveryServiceOptions options = {
        .hosts_max = 16, .host_drop_pings = 4, .ping_ms = 500, .ping_initial_ms = 100,
        .send_addr = &target, .send_addr_size = sizeof(all),
        .broadcast_addrs = broadcasts, .broadcast_num = interface_broadcasts(broadcasts, 8),
        .cb = discovered_hosts, .cb_user = &consoles
    };
    ChiakiDiscoveryService discovery;
    if (chiaki_discovery_service_init(&discovery, &options, &log) != CHIAKI_ERR_SUCCESS) {
        json_object_put(consoles);
        message("error", "PS5 ağ araması başlatılamadı.");
        return 1;
    }
    uint64_t deadline = milliseconds() + 1800;
    while (milliseconds() < deadline && !stdin_closed(50)) {}
    chiaki_discovery_service_fini(&discovery);
    struct json_object *result = event("discovered");
    json_object_object_add(result, "consoles", consoles);
    emit(result);
    return 0;
}

static int pair_console(struct engine *engine, struct json_object *input, const char *address) {
    ChiakiRegist registration;
    ChiakiRegistInfo info = { .target = CHIAKI_TARGET_PS5_1, .host = address, .broadcast = false };
    const char *pin = field(input, "pin");
    if (strlen(pin) != 8 || strspn(pin, "0123456789") != 8 ||
        !from_hex(field(input, "account"), info.psn_account_id, sizeof(info.psn_account_id))) {
        message("error", "PSN hesap kimliği veya eşleştirme kodu geçersiz.");
        return 1;
    }
    info.pin = (uint32_t)strtoul(pin, NULL, 10);
    if (chiaki_regist_start(&registration, &engine->log, &info, registration_event, engine) != CHIAKI_ERR_SUCCESS) {
        message("error", "PS5 eşleştirmesi başlatılamadı.");
        return 1;
    }
    uint64_t deadline = milliseconds() + 35000;
    while (!atomic_load(&engine->registered) && milliseconds() < deadline && !stdin_closed(50)) {}
    if (!atomic_load(&engine->registered)) {
        message("error", "PS5 eşleştirmesi zaman aşımına uğradı.");
        chiaki_regist_stop(&registration);
    }
    chiaki_regist_fini(&registration);
    return 0;
}

static bool video_packet(uint8_t *data, size_t size, int32_t lost, bool recovered, void *context) {
    (void)lost;
    (void)recovered;
    struct engine *engine = context;
    if (!size || atomic_load(&engine->done)) return false;
    atomic_fetch_add(&engine->video_samples, 1);
    if (size > 1024 * 1024) {
        atomic_fetch_add(&engine->dropped_samples, 1);
        return false;
    }
    pthread_mutex_lock(&engine->mutex);
    if (engine->count == QUEUE_SIZE) {
        atomic_fetch_add(&engine->dropped_samples, 1);
        pthread_mutex_unlock(&engine->mutex);
        return false;
    }
    uint8_t *bytes = malloc(size);
    if (!bytes) {
        atomic_fetch_add(&engine->dropped_samples, 1);
        pthread_mutex_unlock(&engine->mutex);
        return false;
    }
    memcpy(bytes, data, size);
    engine->packets[(engine->head + engine->count) % QUEUE_SIZE] = (struct packet){ bytes, size };
    engine->count++;
    pthread_cond_signal(&engine->packet_ready);
    pthread_mutex_unlock(&engine->mutex);
    return true;
}

static struct paddle_area crop_area(struct region region, int frame_width, int frame_height, int left, int top) {
    return (struct paddle_area){ frame_width * region.x / 100.0 - left, frame_height * region.y / 100.0 - top,
        frame_width * (region.x + region.width) / 100.0 - left,
        frame_height * (region.y + region.height) / 100.0 - top };
}

static bool publish_crop(struct engine *engine, uint8_t *const planes[3], const SBufferInfo *picture,
        uint64_t now, bool replace_pending, struct crop *sample, struct subtitle_search *search, bool band_only) {
    const uint8_t *luma = planes[0];
    int frame_width = picture->UsrData.sSystemBuffer.iWidth;
    int frame_height = picture->UsrData.sSystemBuffer.iHeight;
    int stride = picture->UsrData.sSystemBuffer.iStride[0];
    if (!luma || frame_width < 120 || frame_height < 80 || frame_width > MAX_WIDTH ||
        frame_height > MAX_HEIGHT || (!band_only && stride < frame_width)) return false;
    pthread_mutex_lock(&engine->mutex);
    if (!replace_pending && ocr_pending_waiting(&engine->pending, now)) {
        pthread_mutex_unlock(&engine->mutex);
        return false;
    }
    const struct region region = engine->region;
    const struct region dialogue = engine->dialogue_region, objective = engine->objective_region, hint = engine->hint_region;
    pthread_mutex_unlock(&engine->mutex);

    int left = frame_width * region.x / 100;
    int top = frame_height * region.y / 100;
    int right = frame_width - frame_width * (100 - region.x - region.width) / 100;
    int bottom = frame_height - frame_height * (100 - region.y - region.height) / 100;
    int width = right - left;
    int height = bottom - top;
    size_t size = (size_t)width * height;
    if (size > sample->capacity) {
        uint8_t *pixels = realloc(sample->pixels, size * 3);
        if (!pixels) {
            atomic_store(&engine->done, true);
            message("error", "TV altyazı alanı için yeterli bellek ayıramadı.");
            return false;
        }
        sample->pixels = pixels;
        sample->capacity = size;
    }
    if (band_only) memcpy(sample->pixels, luma, size);
    else for (int row = 0; row < height; row++)
        memcpy(sample->pixels + (size_t)row * width, luma + (size_t)(top + row) * stride + left, (size_t)width);

    int band_top, band_bottom;
    subtitle_band(height, frame_height, &band_top, &band_bottom);
    struct subtitle_mark mark;
    sample->candidate = subtitle_candidate_mark(search, sample->pixels + (size_t)band_top * width,
        width, band_bottom - band_top, frame_height, sample->pixels + sample->capacity, &mark);
    if (!sample->candidate && hint.width > 0) {
        // The normal text gate looks near the middle. Check the right strip on
        // its own when a button hint is the only text on screen.
        int hint_left = frame_width * hint.x / 100 - left;
        int hint_top = frame_height * hint.y / 100 - top;
        int hint_right = frame_width - frame_width * (100 - hint.x - hint.width) / 100 - left;
        int hint_bottom = frame_height - frame_height * (100 - hint.y - hint.height) / 100 - top;
        if (hint_left >= 0 && hint_top >= 0 && hint_right <= width && hint_bottom <= height) {
            int hint_width = hint_right - hint_left, hint_height = hint_bottom - hint_top;
            uint8_t *strip = sample->pixels + sample->capacity;
            for (int row = 0; row < hint_height; row++)
                memcpy(strip + (size_t)row * hint_width, sample->pixels + (size_t)(hint_top + row) * width + hint_left,
                    (size_t)hint_width);
            sample->candidate = subtitle_candidate_mark(search, strip, hint_width, hint_height, frame_height,
                strip + (size_t)hint_width * hint_height, &mark);
        }
    }
    sample->width = width;
    sample->height = height;
    sample->left = left;
    sample->top = top + band_top;
    sample->frame_width = frame_width;
    sample->frame_height = frame_height;
    sample->has_regions = objective.width > 0 || hint.width > 0;
    if (sample->has_regions) {
        sample->regions.dialogue = crop_area(dialogue, frame_width, frame_height, left, sample->top);
        sample->regions.objective = crop_area(objective, frame_width, frame_height, left, sample->top);
        sample->regions.hint = crop_area(hint, frame_width, frame_height, left, sample->top);
    }
    sample->revision = region.revision;
    sample->captured_at = now;

    pthread_mutex_lock(&engine->mutex);
    if (engine->region.revision != region.revision || atomic_load(&engine->done)) {
        pthread_mutex_unlock(&engine->mutex);
        return false;
    }
    atomic_store(&engine->last_crop_ms, (unsigned int)now);
    atomic_store(&engine->frame_size, ((unsigned int)frame_width << 16) | (unsigned int)frame_height);
    bool replaced;
    int index = ocr_pending_latest(&engine->pending, now);
    bool duplicate = index >= 0 && engine->crops[index].width == sample->width &&
        engine->crops[index].height == sample->height && engine->crops[index].revision == sample->revision &&
        engine->crops[index].frame_width == sample->frame_width &&
        engine->crops[index].frame_height == sample->frame_height &&
        engine->crops[index].candidate == sample->candidate &&
        memcmp(engine->crops[index].pixels, sample->pixels, size) == 0;
    if (duplicate && ocr_pending_refresh(&engine->pending, index, now)) {
        replaced = true;
        if (sample->candidate) {
            engine->pending.has_visible = true;
            engine->pending.visible = mark;
            engine->pending.last_visible = now;
        }
    } else index = ocr_pending_offer(&engine->pending, sample->candidate ? &mark : NULL, now, &replaced);
    if (index >= 0) {
        struct crop spare = engine->crops[index];
        engine->crops[index] = *sample;
        *sample = spare;
        atomic_fetch_add(&engine->sampled_crops, 1);
        if (replaced) atomic_fetch_add(&engine->replaced_crops, 1);
        pthread_cond_signal(&engine->crop_ready);
    }
    pthread_mutex_unlock(&engine->mutex);
    return true;
}

static void *decode_packets(void *context) {
    struct engine *engine = context;
    uint64_t last_sample = 0;
    struct crop sample = {0};
    struct subtitle_search search = {0};
    for (;;) {
        pthread_mutex_lock(&engine->mutex);
        while (!engine->count && !atomic_load(&engine->done))
            pthread_cond_wait(&engine->packet_ready, &engine->mutex);
        if (atomic_load(&engine->done)) {
            pthread_mutex_unlock(&engine->mutex);
            break;
        }
        struct packet packet = engine->packets[engine->head];
        engine->head = (engine->head + 1) % QUEUE_SIZE;
        engine->count--;
        pthread_mutex_unlock(&engine->mutex);

        uint8_t *planes[3] = { NULL, NULL, NULL };
        SBufferInfo picture = { 0 };
        (*engine->decoder)->DecodeFrameNoDelay(engine->decoder, packet.bytes, (int)packet.size, planes, &picture);
        free(packet.bytes);
        if (picture.iBufferStatus != 1 || !planes[0]) continue;
        atomic_fetch_add(&engine->decoded_frames, 1);
        uint64_t now = milliseconds();
        uint64_t elapsed = now - last_sample;
        // Preserve the sampling intervals. Novel captions take priority over repeating or empty images.
        unsigned int interval = atomic_load(&engine->crop_interval_ms);
        if (elapsed >= interval &&
                publish_crop(engine, planes, &picture, now, true,
                    &sample, &search, false)) last_sample = now;
    }
    free(search.queue);
    free(search.seen);
    free(sample.pixels);
    return NULL;
}

static void report_ocr(const struct paddle_ocr *ocr, const struct paddle_result *result,
        const struct paddle_lines *positions, const struct crop *crop,
        uint64_t queue_ms, uint64_t ocr_ms) {
    struct json_object *value = event("ocr");
    json_object_object_add(value, "text", json_object_new_string(result->text));
    json_object_object_add(value, "confidence", json_object_new_int(result->confidence));
    json_object_object_add(value, "revision", json_object_new_int(crop->revision));
    json_object_object_add(value, "cropAgeMs", json_object_new_int64(milliseconds() - crop->captured_at));
    json_object_object_add(value, "queueMs", json_object_new_int64(queue_ms));
    json_object_object_add(value, "ocrMs", json_object_new_int64(ocr_ms));
    struct paddle_stats stats;
    paddle_stats_read(ocr, &stats);
    json_object_object_add(value, "ocrThreads", json_object_new_int(stats.threads));
    json_object_object_add(value, "readerRuns", json_object_new_int64(stats.reader_runs));
    json_object_object_add(value, "lineCacheHits", json_object_new_int64(stats.line_cache_hits));
    if (positions) {
        struct json_object *lines = json_object_new_array();
        for (int index = 0; index < positions->count; index++) {
            const struct paddle_line *line = &positions->items[index];
            struct json_object *item = json_object_new_object();
            json_object_object_add(item, "text", json_object_new_string_len(result->text + line->offset, line->length));
            json_object_object_add(item, "confidence", json_object_new_int(line->confidence));
            json_object_object_add(item, "x", json_object_new_double(50.0 * (2 * crop->left + line->left + line->right) / crop->frame_width));
            json_object_object_add(item, "y", json_object_new_double(50.0 * (2 * crop->top + line->top + line->bottom) / crop->frame_height));
            json_object_object_add(item, "height", json_object_new_double(100.0 * (line->bottom - line->top) / crop->frame_height));
            json_object_array_add(lines, item);
        }
        json_object_object_add(value, "lines", lines);
    } else json_object_object_add(value, "skipped", json_object_new_boolean(true));
    emit(value);
}

static void report_video_stats(struct engine *engine) {
    struct json_object *value = event("videoStats");
    unsigned int frame_size = atomic_load(&engine->frame_size);
    json_object_object_add(value, "videoSamples", json_object_new_int64(atomic_load(&engine->video_samples)));
    json_object_object_add(value, "droppedSamples", json_object_new_int64(atomic_load(&engine->dropped_samples)));
    json_object_object_add(value, "decodedFrames", json_object_new_int64(atomic_load(&engine->decoded_frames)));
    json_object_object_add(value, "sampledCrops", json_object_new_int64(atomic_load(&engine->sampled_crops)));
    json_object_object_add(value, "replacedCrops", json_object_new_int64(atomic_load(&engine->replaced_crops)));
    json_object_object_add(value, "ocrRuns", json_object_new_int64(atomic_load(&engine->ocr_runs)));
    json_object_object_add(value, "skippedCrops", json_object_new_int64(atomic_load(&engine->skipped_crops)));
    json_object_object_add(value, "ocrIntervalMs", json_object_new_int(atomic_load(&engine->crop_interval_ms)));
    pthread_mutex_lock(&engine->mutex);
    json_object_object_add(value, "expiredCrops", json_object_new_int64(engine->pending.expired));
    json_object_object_add(value, "refreshedCrops", json_object_new_int64(engine->pending.refreshed));
    pthread_mutex_unlock(&engine->mutex);
    json_object_object_add(value, "width", json_object_new_int(frame_size >> 16));
    json_object_object_add(value, "height", json_object_new_int(frame_size & 0xffff));
    emit(value);
}

static void report_capture(const struct sample_capture *capture, bool complete) {
    struct json_object *value = event("sampleCapture");
    json_object_object_add(value, "directory", json_object_new_string(capture->directory));
    json_object_object_add(value, "frames", json_object_new_int((int)capture->saved));
    json_object_object_add(value, "complete", json_object_new_boolean(complete));
    emit(value);
}

static bool save_crop_sample(const struct sample_capture *capture, const struct crop *crop) {
    char filename[80];
    snprintf(filename, sizeof(filename), "%s/frame-%02u.bin", capture->directory, capture->saved + 1);
    FILE *file = fopen(filename, "wb");
    if (!file) return false;
    size_t pixels = (size_t)crop->width * crop->height;
    bool saved = fprintf(file, "GTAVI-CROP 1\n%d %d %d 0 0 0 0\n", crop->width,
        crop->height, crop->frame_height) > 0 && fwrite(crop->pixels, 1, pixels, file) == pixels;
    if (fclose(file) != 0) saved = false;
    if (saved && chmod(filename, 0644) == 0) return true;
    unlink(filename);
    return false;
}

static void capture_crop(struct engine *engine, struct sample_capture *capture, const struct crop *crop) {
    unsigned int requested = atomic_exchange(&engine->capture_requested, 0);
    if (requested && !capture->requested) {
        *capture = (struct sample_capture){.directory = "/tmp/gtavi-ocr-XXXXXX", .requested = requested};
        if (!mkdtemp(capture->directory)) {
            capture->directory[0] = '\0';
            capture->requested = 0;
            report_capture(capture, true);
            return;
        }
        if (chmod(capture->directory, 0755) != 0) {
            rmdir(capture->directory);
            capture->directory[0] = '\0';
            capture->requested = 0;
            report_capture(capture, true);
            return;
        }
        report_capture(capture, false);
    }
    if (!capture->requested || milliseconds() < capture->next_sample) return;
    if (save_crop_sample(capture, crop)) capture->saved++;
    else capture->requested = capture->saved;
    capture->next_sample = milliseconds() + CAPTURE_INTERVAL_MS;
    if (capture->saved >= capture->requested) {
        capture->requested = 0;
        report_capture(capture, true);
    }
}

static void *read_subtitles(void *context) {
    struct engine *engine = context;
    struct crop crop = { 0 };
    size_t previous_size = 0;
    int previous_width = 0;
    int previous_revision = -1;
    int previous_frame_width = 0;
    int previous_frame_height = 0;
    uint64_t next_probe = 0;
    struct sample_capture capture = {0};
    struct paddle_result result = {0};
    struct paddle_lines positions = {0};
    while (!atomic_load(&engine->done)) {
        pthread_mutex_lock(&engine->mutex);
        int index = ocr_pending_take(&engine->pending, milliseconds());
        while (index < 0 && !atomic_load(&engine->done)) {
            pthread_cond_wait(&engine->crop_ready, &engine->mutex);
            index = ocr_pending_take(&engine->pending, milliseconds());
        }
        if (atomic_load(&engine->done)) {
            pthread_mutex_unlock(&engine->mutex);
            break;
        }
        const struct crop *pending = &engine->crops[index];
        crop.width = pending->width;
        crop.height = pending->height;
        crop.left = pending->left;
        crop.top = pending->top;
        crop.frame_width = pending->frame_width;
        crop.frame_height = pending->frame_height;
        crop.has_regions = pending->has_regions;
        crop.regions = pending->regions;
        crop.revision = pending->revision;
        crop.candidate = pending->candidate;
        crop.captured_at = pending->captured_at;
        size_t size = (size_t)crop.width * (size_t)crop.height;
        if (size > crop.capacity) {
            uint8_t *buffers = realloc(crop.pixels, size * 2);
            if (!buffers) {
                atomic_store(&engine->done, true);
                pthread_mutex_unlock(&engine->mutex);
                message("error", "TV altyazı okumak için yeterli bellek ayıramadı.");
                break;
            }
            crop.pixels = buffers;
            crop.capacity = size;
            previous_size = 0;
        }
        memcpy(crop.pixels, pending->pixels, size);
        pthread_mutex_unlock(&engine->mutex);
        uint64_t queue_ms = milliseconds() - crop.captured_at;

        capture_crop(engine, &capture, &crop);
        // Keep the current crop and the last model input together.
        uint8_t *previous = crop.pixels + crop.capacity;
        bool unchanged = previous_size == size && previous_width == crop.width &&
            previous_revision == crop.revision && previous_frame_width == crop.frame_width &&
            previous_frame_height == crop.frame_height &&
            memcmp(previous, crop.pixels, size) == 0;
        if (unchanged) {
            atomic_fetch_add(&engine->skipped_crops, 1);
            report_ocr(engine->ocr, &result, &positions, &crop, queue_ms, 0);
            continue;
        }

        int top, bottom;
        subtitle_band(crop.height, crop.frame_height, &top, &bottom);
        bool candidate = crop.candidate;
        uint64_t now = milliseconds();
        if (!candidate && now < next_probe && previous_revision == crop.revision) {
            atomic_fetch_add(&engine->skipped_crops, 1);
            report_ocr(engine->ocr, &(struct paddle_result){0}, NULL, &crop, queue_ms, 0);
            continue;
        }

        // The full selected area is also probed periodically when the cheap
        // text gate cannot identify an atypical caption.
        bool had_text = result.confidence > 0;
        atomic_fetch_add(&engine->ocr_runs, 1);
        uint64_t ocr_started = milliseconds();
        if (!paddle_read_lines(engine->ocr, crop.pixels + (size_t)top * crop.width, crop.width,
                bottom - top, crop.frame_height, &result, &positions, crop.has_regions ? &crop.regions : NULL)) {
            message("error", "PaddleOCR altyazı karesini işleyemedi.");
            atomic_store(&engine->done, true);
            break;
        }
        uint64_t ocr_ms = milliseconds() - ocr_started;
        // Start the quiet interval after inference and prioritize another read
        // if a probe found actual text.
        next_probe = milliseconds() + (!candidate && !had_text && result.confidence ?
            atomic_load(&engine->crop_interval_ms) : BACKGROUND_PROBE_MS);
        memcpy(previous, crop.pixels, size);
        previous_size = size;
        previous_width = crop.width;
        previous_revision = crop.revision;
        previous_frame_width = crop.frame_width;
        previous_frame_height = crop.frame_height;
        report_ocr(engine->ocr, &result, &positions, &crop, queue_ms, ocr_ms);
    }
    if (capture.requested) report_capture(&capture, true);
    free(crop.pixels);
    return NULL;
}

static void stream_event(ChiakiEvent *status, void *context) {
    struct engine *engine = context;
    if (status->type == CHIAKI_EVENT_CONNECTED) {
        atomic_store(&engine->last_crop_ms, (unsigned int)milliseconds());
        atomic_store(&engine->video_connected, true);
        emit(event("ready"));
    } else if (status->type == CHIAKI_EVENT_QUIT || status->type == CHIAKI_EVENT_LOGIN_PIN_REQUEST) {
        if (!atomic_load(&engine->done)) {
            const char *reason = status->type == CHIAKI_EVENT_QUIT
                ? chiaki_quit_reason_string(status->quit.reason)
                : "Önce ikinci hesabın PS5 oturum PIN’ini konsolda aç.";
            message("error", reason ? reason : "PS5 bağlantısı kesildi.");
        }
        atomic_store(&engine->done, true);
    }
}

static int stream_console(struct engine *engine, struct json_object *input, const char *address, const char *runtime) {
    atomic_store(&engine->crop_interval_ms, ocr_interval(nonnegative_int(input, "ocrRate")));
    engine->region = default_region;
    parse_region(input, "region", 5, &engine->region);
    parse_text_regions(engine, input);
    ChiakiConnectInfo info = { .ps5 = true, .host = address, .enable_idr_on_fec_failure = true };
    if (!from_hex(field(input, "registKey"), (uint8_t *)info.regist_key, sizeof(info.regist_key)) ||
        !from_hex(field(input, "rpKey"), info.morning, sizeof(info.morning))) {
        message("error", "Kayıtlı PS5 eşleştirmesi geçersiz. Cihazı yeniden eşleştir.");
        return 1;
    }
    from_hex(field(input, "account"), info.psn_account_id, sizeof(info.psn_account_id));
    ChiakiVideoResolutionPreset resolution;
    switch (nonnegative_int(input, "quality")) {
    case 360: resolution = CHIAKI_VIDEO_RESOLUTION_PRESET_360p; break;
    case 720: resolution = CHIAKI_VIDEO_RESOLUTION_PRESET_720p; break;
    case 1080: resolution = CHIAKI_VIDEO_RESOLUTION_PRESET_1080p; break;
    default: resolution = CHIAKI_VIDEO_RESOLUTION_PRESET_540p; break;
    }
    chiaki_connect_video_profile_preset(&info.video_profile, resolution, CHIAKI_VIDEO_FPS_PRESET_30);
    info.video_profile.codec = CHIAKI_CODEC_H264;
    info.video_profile_auto_downgrade = true;
    info.packet_loss_max = 0.05;

    int result = 1;
    bool decoder_initialized = false;
    bool session_initialized = false;
    bool session_started = false;
    bool decoding = false;
    bool recognizing = false;
    pthread_t decoder_thread;
    pthread_t ocr_thread;
    SDecodingParam decoder_options = { 0 };
    if (WelsCreateDecoder(&engine->decoder) != 0 || !engine->decoder ||
        (*engine->decoder)->Initialize(engine->decoder, &decoder_options) != 0) {
        message("error", "H.264 video çözücü başlatılamadı.");
        goto cleanup;
    }
    decoder_initialized = true;
    engine->ocr = paddle_open(runtime);
    if (!engine->ocr) {
        message("error", "PaddleOCR altyazı modeli açılamadı.");
        goto cleanup;
    }

    if (chiaki_session_init(&engine->session, &info, &engine->log) != CHIAKI_ERR_SUCCESS) {
        message("error", "PS5 Uzaktan Oynatma oturumu hazırlanamadı.");
        goto cleanup;
    }
    session_initialized = true;
    chiaki_session_set_event_cb(&engine->session, stream_event, engine);
    chiaki_session_set_video_sample_cb(&engine->session, video_packet, engine);
    decoding = pthread_create(&decoder_thread, NULL, decode_packets, engine) == 0;
    recognizing = decoding && pthread_create(&ocr_thread, NULL, read_subtitles, engine) == 0;
    if (!recognizing || chiaki_session_start(&engine->session) != CHIAKI_ERR_SUCCESS) {
        message("error", "PS5 altyazı akışı başlatılamadı.");
        goto cleanup;
    }
    session_started = true;
    uint64_t next_idr = 0;
    uint64_t next_stats = milliseconds() + 2000;
    while (!atomic_load(&engine->done) && receive_stream_control(engine)) {
        if (atomic_load(&engine->done)) break;
        uint64_t now = milliseconds();
        if (now >= next_stats) {
            report_video_stats(engine);
            next_stats = now + 2000;
        }
        if (!atomic_load(&engine->video_connected) || now < next_idr ||
                (unsigned int)now - atomic_load(&engine->last_crop_ms) < 1800) continue;
        next_idr = now + 2500;
        chiaki_session_request_idr(&engine->session);
    }
    result = 0;

cleanup:
    pthread_mutex_lock(&engine->mutex);
    atomic_store(&engine->done, true);
    pthread_cond_broadcast(&engine->packet_ready);
    pthread_cond_broadcast(&engine->crop_ready);
    pthread_mutex_unlock(&engine->mutex);
    if (session_started) {
        chiaki_session_stop(&engine->session);
        chiaki_session_join(&engine->session);
    }
    if (decoding) pthread_join(decoder_thread, NULL);
    if (recognizing) pthread_join(ocr_thread, NULL);
    for (int index = 0; index < OCR_PENDING_SLOTS; index++) free(engine->crops[index].pixels);
    for (size_t index = 0; index < engine->count; index++)
        free(engine->packets[(engine->head + index) % QUEUE_SIZE].bytes);
    if (session_initialized) chiaki_session_fini(&engine->session);
    paddle_close(engine->ocr);
    if (decoder_initialized) (*engine->decoder)->Uninitialize(engine->decoder);
    if (engine->decoder) WelsDestroyDecoder(engine->decoder);
    return result;
}

#ifdef HDMI_ONLY
static int stream_hdmi(struct engine *engine, struct json_object *input, const char *runtime) {
    atomic_store(&engine->crop_interval_ms, ocr_interval(nonnegative_int(input, "ocrRate")));
    engine->region = default_region;
    parse_region(input, "region", 5, &engine->region);
    parse_text_regions(engine, input);
    uint8_t *jpeg = malloc(HDMI_MAX_JPEG);
    uint8_t *band = malloc(HDMI_WIDTH * HDMI_HEIGHT);
    engine->ocr = paddle_open(runtime);
    pthread_t reader;
    int result = 1;
    if (!jpeg || !band || !engine->ocr || pthread_create(&reader, NULL, read_subtitles, engine) != 0) {
        message("error", "HDMI altyazı motoru başlatılamadı.");
        goto done;
    }
    struct crop sample = {0};
    struct subtitle_search search = {0};
    SBufferInfo frame = {0};
    frame.UsrData.sSystemBuffer.iWidth = HDMI_WIDTH;
    frame.UsrData.sSystemBuffer.iHeight = HDMI_HEIGHT;
    char line[512];
    emit(event("ready"));
    while (!atomic_load(&engine->done) && fgets(line, sizeof(line), stdin)) {
        if (line[0] == '{') {
            apply_stream_control(engine, line);
            continue;
        }
        unsigned int length;
        struct region region = engine->region;
        uint64_t received = milliseconds();
        if (sscanf(line, "JPEG %u", &length) != 1 || !length || length > HDMI_MAX_JPEG ||
                fread(jpeg, 1, length, stdin) != length ||
                !hdmi_decode_band(jpeg, length, HDMI_WIDTH * region.x / 100, HDMI_HEIGHT * region.y / 100,
                    HDMI_WIDTH - HDMI_WIDTH * (100 - region.x - region.width) / 100,
                    HDMI_HEIGHT - HDMI_HEIGHT * (100 - region.y - region.height) / 100, band)) {
            message("error", "HDMI ekran görüntüsü çözülemedi.");
            goto stop;
        }
        uint8_t *planes[3] = {band, NULL, NULL};
        atomic_fetch_add(&engine->decoded_frames, 1);
        publish_crop(engine, planes, &frame, received, true, &sample, &search, true);
        struct json_object *accepted = event("frameAccepted");
        json_object_object_add(accepted, "decodeMs", json_object_new_int64(milliseconds() - received));
        emit(accepted);
    }
    result = 0;
stop:
    pthread_mutex_lock(&engine->mutex);
    atomic_store(&engine->done, true);
    pthread_cond_broadcast(&engine->crop_ready);
    pthread_mutex_unlock(&engine->mutex);
    pthread_join(reader, NULL);
    free(search.queue);
    free(search.seen);
    free(sample.pixels);
    for (int index = 0; index < OCR_PENDING_SLOTS; ++index) free(engine->crops[index].pixels);
done:
    paddle_close(engine->ocr);
    free(band);
    free(jpeg);
    return result;
}
#endif

int main(int argc, char **argv) {
    if (argc != 2) return 1;
    setvbuf(stdin, NULL, _IONBF, 0);
    char line[4096];
    if (!fgets(line, sizeof(line), stdin)) return 1;
    struct json_object *input = json_tokener_parse(line);
    if (!input) return 1;
    const char *mode = field(input, "mode");
    int result = 1;
    struct engine *engine = NULL;
#ifdef HDMI_ONLY
    if (strcmp(mode, "hdmi") != 0) goto done;
#else
    const char *address = field(input, "address");
    struct in_addr ip;
    if (chiaki_lib_init() != CHIAKI_ERR_SUCCESS) {
        message("error", "Uzaktan Oynatma altyapısı başlatılamadı.");
        goto done;
    }
    if (strcmp(mode, "discover") == 0) {
        result = discover_consoles();
        goto done;
    }
    if (inet_pton(AF_INET, address, &ip) != 1) {
        message("error", "PS5 bağlantısı için geçerli bir IP adresi gerekli.");
        goto done;
    }
#endif
    engine = calloc(1, sizeof(*engine));
    if (!engine) {
        message("error", "TV altyazı motoru için yeterli bellek yok.");
        goto done;
    }
#ifndef HDMI_ONLY
    chiaki_log_init(&engine->log, 0, NULL, NULL);
#endif
    atomic_init(&engine->done, false);
    atomic_init(&engine->registered, false);
    atomic_init(&engine->video_connected, false);
    atomic_init(&engine->last_crop_ms, 0);
    atomic_init(&engine->video_samples, 0);
    atomic_init(&engine->dropped_samples, 0);
    atomic_init(&engine->decoded_frames, 0);
    atomic_init(&engine->sampled_crops, 0);
    atomic_init(&engine->replaced_crops, 0);
    atomic_init(&engine->ocr_runs, 0);
    atomic_init(&engine->skipped_crops, 0);
    atomic_init(&engine->capture_requested, 0);
    atomic_init(&engine->frame_size, 0);
    pthread_mutex_init(&engine->mutex, NULL);
    pthread_cond_init(&engine->packet_ready, NULL);
    pthread_cond_init(&engine->crop_ready, NULL);
#ifdef HDMI_ONLY
    result = stream_hdmi(engine, input, argv[1]);
#else
    if (strcmp(mode, "pair") == 0) result = pair_console(engine, input, address);
    else if (strcmp(mode, "stream") == 0) result = stream_console(engine, input, address, argv[1]);
#endif
    pthread_cond_destroy(&engine->crop_ready);
    pthread_cond_destroy(&engine->packet_ready);
    pthread_mutex_destroy(&engine->mutex);

done:
    free(engine);
    json_object_put(input);
    return result;
}
