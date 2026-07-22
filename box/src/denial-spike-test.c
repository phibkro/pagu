#define _GNU_SOURCE
#define PAGU_DENIAL_SPIKE_TESTING
#include "denial-spike.c"

static void require(bool condition, const char *message) {
  if (!condition) {
    fprintf(stderr, "denial-spike-test: %s\n", message);
    exit(1);
  }
}

int main(void) {
  char *json = NULL;
  size_t size = 0;
  FILE *stream = open_memstream(&json, &size);
  require(stream != NULL, "open_memstream");
  require(
      write_record_at(stream, "openat", "/secret/quote\"\\\n",
                      "2026-07-22T10:11:12.345Z", "worker") == 0,
      "write record");
  require(fclose(stream) == 0, "close record stream");
  require(
      strcmp(json,
             "{\"version\":1,\"syscall\":\"openat\",\"path\":"
             "\"/secret/quote\\\"\\\\\\n\",\"verdict\":\"deny\","
             "\"ts\":\"2026-07-22T10:11:12.345Z\","
             "\"profile\":\"worker\"}\n") == 0,
      "exact structured denial record");
  free(json);

  require(strcmp(syscall_name(__NR_openat), "openat") == 0,
          "openat syscall name");
  const struct deny_rule denied[] = {
      {.path = "/home/user/.ssh", .subtree = true},
      {.path = "/home/user/.netrc", .subtree = false},
      {.path = "/trailing/", .subtree = true},
  };
  require(path_is_denied("/home/user/.ssh/key", denied, 2),
          "exact path denied");
  require(path_is_denied("/home/user/.ssh/nested/key", denied, 2),
          "deny tree covers descendants");
  require(path_is_denied("/home/user/.netrc", denied, 2),
          "deny file matches exactly");
  require(!path_is_denied("/home/user/.netrc/child", denied, 2),
          "deny file does not cover descendants");
  require(!path_is_denied("/home/user/.ssh-other/key", denied, 2),
          "string prefix is not a deny-tree descendant");
  require(!path_is_denied("/home/user/public", denied, 2),
          "non-denied path is not classified");
  require(path_is_denied("/trailing/child", denied, 3),
          "trailing slash deny tree covers descendants");

  require(is_canonical_absolute("/home/user/.ssh/key"),
          "absolute path is canonical");
  require(!is_canonical_absolute("/home/user/.ssh/../public"),
          "dot-dot path is ambiguous");
  require(!is_canonical_absolute("/home/user/.ssh//key"),
          "repeated separator is ambiguous");
  require(!is_canonical_absolute("/home/user/.ssh/./key"),
          "dot component is ambiguous");
  require(is_valid_utf8("/home/user/.ssh/\xc3\xa6"),
          "UTF-8 path accepted");
  const char invalid_utf8[] = {'/', 'x', (char)0xff, '\0'};
  require(!is_valid_utf8(invalid_utf8), "non-UTF-8 path rejected");

  char log_path[] = "denial-log.XXXXXX";
  int log_fd = mkstemp(log_path);
  require(log_fd >= 0, "create log fixture");
  require(fchmod(log_fd, 0600) == 0, "secure log fixture mode");
  require(validate_log_fd(log_fd) == 0, "owned private regular log accepted");
  char alias_path[] = "denial-log-alias";
  unlink(alias_path);
  require(link(log_path, alias_path) == 0, "create hardlink alias");
  require(validate_log_fd(log_fd) < 0, "hardlinked log rejected");
  require(unlink(alias_path) == 0 && unlink(log_path) == 0,
          "remove log fixtures");
  close(log_fd);
  return 0;
}
