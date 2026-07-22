#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#if defined(__x86_64__)
#define PAGU_AUDIT_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define PAGU_AUDIT_ARCH AUDIT_ARCH_AARCH64
#else
#error "pagu-denial-spike supports x86_64 and aarch64 Linux"
#endif

#ifndef SECCOMP_USER_NOTIF_FLAG_CONTINUE
#define SECCOMP_USER_NOTIF_FLAG_CONTINUE (1UL << 0)
#endif

#define PATH_LIMIT 4096

static const char *syscall_name(int nr) {
#ifdef __NR_open
  if (nr == __NR_open) return "open";
#endif
  if (nr == __NR_openat) return "openat";
  return NULL;
}

struct deny_rule {
  const char *path;
  bool subtree;
};

static bool is_canonical_absolute(const char *path) {
  if (path[0] != '/') return false;
  if (path[1] == '\0') return true;
  if (path[1] == '/' || path[strlen(path) - 1] == '/') return false;
  const char *component = path + 1;
  while (*component != '\0') {
    const char *slash = strchr(component, '/');
    size_t length = slash == NULL ? strlen(component) : (size_t)(slash - component);
    if (length == 0 || (length == 1 && component[0] == '.') ||
        (length == 2 && component[0] == '.' && component[1] == '.')) {
      return false;
    }
    if (slash == NULL) return true;
    component = slash + 1;
  }
  return true;
}

static bool is_valid_utf8(const char *value) {
  const unsigned char *p = (const unsigned char *)value;
  while (*p != 0) {
    if (*p <= 0x7f) {
      p++;
      continue;
    }
    uint32_t codepoint;
    size_t continuation;
    if ((*p & 0xe0) == 0xc0) {
      codepoint = *p & 0x1f;
      continuation = 1;
    } else if ((*p & 0xf0) == 0xe0) {
      codepoint = *p & 0x0f;
      continuation = 2;
    } else if ((*p & 0xf8) == 0xf0) {
      codepoint = *p & 0x07;
      continuation = 3;
    } else {
      return false;
    }
    p++;
    for (size_t i = 0; i < continuation; i++, p++) {
      if ((*p & 0xc0) != 0x80) return false;
      codepoint = (codepoint << 6) | (*p & 0x3f);
    }
    if ((continuation == 1 && codepoint < 0x80) ||
        (continuation == 2 && codepoint < 0x800) ||
        (continuation == 3 && codepoint < 0x10000) ||
        codepoint > 0x10ffff ||
        (codepoint >= 0xd800 && codepoint <= 0xdfff)) {
      return false;
    }
  }
  return true;
}

static bool path_is_denied(const char *path, const struct deny_rule *rules,
                           size_t denied_count) {
  for (size_t i = 0; i < denied_count; i++) {
    size_t length = strlen(rules[i].path);
    while (length > 1 && rules[i].path[length - 1] == '/') length--;
    if (strncmp(path, rules[i].path, length) == 0 && path[length] == '\0') {
      return true;
    }
    if (rules[i].subtree && strncmp(path, rules[i].path, length) == 0 &&
        (length == 1 || path[length] == '/')) {
      return true;
    }
  }
  return false;
}

static int write_json_string(FILE *out, const char *value) {
  if (fputc('"', out) == EOF) return -1;
  for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
    switch (*p) {
      case '"':
        if (fputs("\\\"", out) == EOF) return -1;
        break;
      case '\\':
        if (fputs("\\\\", out) == EOF) return -1;
        break;
      case '\b':
        if (fputs("\\b", out) == EOF) return -1;
        break;
      case '\f':
        if (fputs("\\f", out) == EOF) return -1;
        break;
      case '\n':
        if (fputs("\\n", out) == EOF) return -1;
        break;
      case '\r':
        if (fputs("\\r", out) == EOF) return -1;
        break;
      case '\t':
        if (fputs("\\t", out) == EOF) return -1;
        break;
      default:
        if (*p < 0x20) {
          if (fprintf(out, "\\u%04x", *p) < 0) return -1;
        } else if (fputc(*p, out) == EOF) {
          return -1;
        }
    }
  }
  return fputc('"', out) == EOF ? -1 : 0;
}

static int write_record_at(FILE *out, const char *call, const char *path,
                           const char *timestamp, const char *profile) {
  if (fputs("{\"version\":1,\"syscall\":", out) == EOF ||
      write_json_string(out, call) < 0 || fputs(",\"path\":", out) == EOF ||
      write_json_string(out, path) < 0 ||
      fputs(",\"verdict\":\"deny\",\"ts\":", out) == EOF ||
      write_json_string(out, timestamp) < 0) {
    return -1;
  }
  if (profile != NULL &&
      (fputs(",\"profile\":", out) == EOF ||
       write_json_string(out, profile) < 0)) {
    return -1;
  }
  if (fputs("}\n", out) == EOF) return -1;
  return fflush(out);
}

static int timestamp_now(char *out, size_t size) {
  struct timespec now;
  struct tm utc;
  if (clock_gettime(CLOCK_REALTIME, &now) < 0 ||
      gmtime_r(&now.tv_sec, &utc) == NULL) {
    return -1;
  }
  int written = snprintf(out, size, "%04d-%02d-%02dT%02d:%02d:%02d.%03ldZ",
                         utc.tm_year + 1900, utc.tm_mon + 1, utc.tm_mday,
                         utc.tm_hour, utc.tm_min, utc.tm_sec,
                         now.tv_nsec / 1000000);
  return written > 0 && (size_t)written < size ? 0 : -1;
}

static int install_listener(void) {
  struct sock_filter instructions[] = {
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
               offsetof(struct seccomp_data, arch)),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, PAGU_AUDIT_ARCH, 1, 0),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#ifdef __NR_open
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_open, 0, 1),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF),
#endif
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_openat, 0, 1),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = {
      .len = (unsigned short)(sizeof(instructions) / sizeof(instructions[0])),
      .filter = instructions,
  };
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) return -1;
  return (int)syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER,
                      SECCOMP_FILTER_FLAG_NEW_LISTENER, &program);
}

static int send_install_result(int socket_fd, int listener_fd, int error) {
  struct msghdr message = {0};
  struct iovec iov = {.iov_base = &error, .iov_len = sizeof(error)};
  char control[CMSG_SPACE(sizeof(int))] = {0};
  message.msg_iov = &iov;
  message.msg_iovlen = 1;
  if (listener_fd >= 0) {
    message.msg_control = control;
    message.msg_controllen = sizeof(control);
    struct cmsghdr *header = CMSG_FIRSTHDR(&message);
    header->cmsg_level = SOL_SOCKET;
    header->cmsg_type = SCM_RIGHTS;
    header->cmsg_len = CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(header), &listener_fd, sizeof(listener_fd));
  }
  return sendmsg(socket_fd, &message, 0) == (ssize_t)sizeof(error) ? 0 : -1;
}

static int receive_listener(int socket_fd) {
  int error = 0;
  struct msghdr message = {0};
  struct iovec iov = {.iov_base = &error, .iov_len = sizeof(error)};
  char control[CMSG_SPACE(sizeof(int))] = {0};
  message.msg_iov = &iov;
  message.msg_iovlen = 1;
  message.msg_control = control;
  message.msg_controllen = sizeof(control);
  if (recvmsg(socket_fd, &message, 0) != (ssize_t)sizeof(error)) {
    errno = EPROTO;
    return -1;
  }
  if (error != 0) {
    errno = error;
    return -1;
  }
  struct cmsghdr *header = CMSG_FIRSTHDR(&message);
  if (header == NULL || header->cmsg_level != SOL_SOCKET ||
      header->cmsg_type != SCM_RIGHTS ||
      header->cmsg_len != CMSG_LEN(sizeof(int))) {
    errno = EPROTO;
    return -1;
  }
  int listener_fd = -1;
  memcpy(&listener_fd, CMSG_DATA(header), sizeof(listener_fd));
  return listener_fd;
}

static int read_remote_string(pid_t pid, uintptr_t address, char *out,
                              size_t size) {
  size_t used = 0;
  while (used + 1 < size) {
    size_t chunk = size - used - 1;
    if (chunk > 256) chunk = 256;
    struct iovec local = {.iov_base = out + used, .iov_len = chunk};
    struct iovec remote = {
        .iov_base = (void *)(address + used), .iov_len = chunk};
    ssize_t read = process_vm_readv(pid, &local, 1, &remote, 1, 0);
    if (read <= 0) return -1;
    void *end = memchr(out + used, '\0', (size_t)read);
    if (end != NULL) return 0;
    used += (size_t)read;
  }
  out[size - 1] = '\0';
  errno = ENAMETOOLONG;
  return -1;
}

static uintptr_t path_argument(const struct seccomp_notif *request) {
#ifdef __NR_open
  if (request->data.nr == __NR_open) return request->data.args[0];
#endif
  return request->data.args[1];
}

static int supervise(int listener_fd, pid_t child, FILE *log,
                     const struct deny_rule *rules, size_t denied_count,
                     const char *profile) {
  bool path_read_warning = false;
  bool child_reaped = false;
  int child_status = 0;
  while (!child_reaped) {
    struct pollfd watched = {.fd = listener_fd, .events = POLLIN};
    int ready = poll(&watched, 1, 100);
    if (ready < 0 && errno != EINTR) return -1;
    if (ready > 0 && (watched.revents & POLLIN)) {
      struct seccomp_notif request = {0};
      if (ioctl(listener_fd, SECCOMP_IOCTL_NOTIF_RECV, &request) < 0) {
        if (errno != EINTR && errno != ENOENT) return -1;
      } else {
        struct seccomp_notif_resp response = {.id = request.id};
        const char *call = syscall_name(request.data.nr);
        char path[PATH_LIMIT];
        bool readable = call != NULL &&
                        read_remote_string(request.pid,
                                           path_argument(&request), path,
                                           sizeof(path)) == 0;
        if (call != NULL && !readable && !path_read_warning) {
          perror("pagu-denial-observer: process_vm_readv path");
          path_read_warning = true;
        }
        bool deny = readable && is_canonical_absolute(path) &&
                    is_valid_utf8(path) &&
                    path_is_denied(path, rules, denied_count);
        if (deny) {
          response.error = -EACCES;
        } else {
          response.flags = SECCOMP_USER_NOTIF_FLAG_CONTINUE;
        }
        if (ioctl(listener_fd, SECCOMP_IOCTL_NOTIF_ID_VALID, &request.id) == 0 &&
            ioctl(listener_fd, SECCOMP_IOCTL_NOTIF_SEND, &response) == 0) {
          if (deny) {
            char timestamp[32];
            if (timestamp_now(timestamp, sizeof(timestamp)) < 0 ||
                write_record_at(log, call, path, timestamp, profile) < 0) {
              return -1;
            }
          }
        } else if (errno != ENOENT) {
          return -1;
        }
      }
    }
    pid_t waited = waitpid(child, &child_status, WNOHANG);
    if (waited == child) child_reaped = true;
    if (waited < 0) return -1;
  }
  return child_status;
}

static int validate_log_fd(int fd) {
  struct stat info;
  if (fstat(fd, &info) < 0) return -1;
  if (!S_ISREG(info.st_mode) || info.st_uid != geteuid() ||
      (info.st_mode & 0077) != 0 || info.st_nlink != 1) {
    errno = EPERM;
    return -1;
  }
  return 0;
}

static void stop_child(pid_t child) {
  int status;
  pid_t waited;
  do {
    waited = waitpid(child, &status, WNOHANG);
  } while (waited < 0 && errno == EINTR);
  if (waited != 0) return;
  if (kill(child, SIGKILL) < 0 && errno != ESRCH) {
    perror("pagu-denial-observer: kill child");
  }
  while (waitpid(child, &status, 0) < 0 && errno == EINTR) {
  }
}

static void usage(FILE *out) {
  fprintf(out,
          "usage: pagu-denial-observer --log FILE "
          "(--deny-path|--deny-tree) ABSOLUTE [...] "
          "[--profile NAME] -- "
          "COMMAND [ARGS...]\n"
          "       pagu-denial-observer --probe ABSOLUTE\n"
          "       pagu-denial-observer --probe-allowed ABSOLUTE\n");
}

#ifndef PAGU_DENIAL_SPIKE_TESTING
int main(int argc, char **argv) {
  if (argc == 3 && strcmp(argv[1], "--probe") == 0 && argv[2][0] == '/') {
    int fd = (int)syscall(SYS_openat, AT_FDCWD, argv[2], O_RDONLY, 0);
    if (fd >= 0) {
      close(fd);
      fprintf(stderr, "pagu-denial-observer: probe unexpectedly opened path\n");
      return 1;
    }
    int probe_error = errno;
    perror("pagu-denial-observer: probe openat");
    return probe_error == EACCES ? 0 : 1;
  }
  if (argc == 3 && strcmp(argv[1], "--probe-allowed") == 0 &&
      argv[2][0] == '/') {
    int fd = (int)syscall(SYS_openat, AT_FDCWD, argv[2], O_RDONLY, 0);
    if (fd < 0) {
      perror("pagu-denial-observer: allowed probe openat");
      return 1;
    }
    close(fd);
    return 0;
  }
  const char *log_path = NULL;
  const char *profile = NULL;
  struct deny_rule *rules = calloc((size_t)argc, sizeof(*rules));
  if (rules == NULL) {
    perror("pagu-denial-observer: allocate deny paths");
    return 1;
  }
  size_t denied_count = 0;
  int command_index = 0;
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--log") == 0 && i + 1 < argc) {
      log_path = argv[++i];
    } else if ((strcmp(argv[i], "--deny-path") == 0 ||
                strcmp(argv[i], "--deny-tree") == 0) &&
               i + 1 < argc) {
      bool subtree = strcmp(argv[i], "--deny-tree") == 0;
      const char *path = argv[++i];
      if (path[0] != '/') {
        usage(stderr);
        free(rules);
        return 64;
      }
      rules[denied_count++] = (struct deny_rule){
          .path = path,
          .subtree = subtree,
      };
    } else if (strcmp(argv[i], "--profile") == 0 && i + 1 < argc) {
      profile = argv[++i];
    } else if (strcmp(argv[i], "--") == 0) {
      command_index = i + 1;
      break;
    } else {
      usage(stderr);
      free(rules);
      return 64;
    }
  }
  if (log_path == NULL || denied_count == 0 ||
      command_index == 0 || command_index >= argc) {
    usage(stderr);
    free(rules);
    return 64;
  }

  int log_fd = open(log_path,
                    O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC | O_NOFOLLOW,
                    0600);
  if (log_fd >= 0 && validate_log_fd(log_fd) < 0) {
    perror("pagu-denial-observer: unsafe log file");
    close(log_fd);
    free(rules);
    return 1;
  }
  FILE *log = log_fd < 0 ? NULL : fdopen(log_fd, "w");
  if (log == NULL) {
    perror("pagu-denial-observer: open log");
    if (log_fd >= 0) close(log_fd);
    free(rules);
    return 1;
  }
  int sockets[2];
  if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, sockets) < 0) {
    perror("pagu-denial-observer: socketpair");
    fclose(log);
    free(rules);
    return 1;
  }
  pid_t child = fork();
  if (child < 0) {
    perror("pagu-denial-observer: fork");
    fclose(log);
    free(rules);
    return 1;
  }
  if (child == 0) {
    close(sockets[0]);
    int listener_fd = install_listener();
    int install_error = listener_fd < 0 ? errno : 0;
    if (send_install_result(sockets[1], listener_fd, install_error) < 0) {
      _exit(125);
    }
    close(sockets[1]);
    if (listener_fd < 0) _exit(126);
    close(listener_fd);
    execvp(argv[command_index], &argv[command_index]);
    _exit(127);
  }

  close(sockets[1]);
  int listener_fd = receive_listener(sockets[0]);
  close(sockets[0]);
  if (listener_fd < 0) {
    perror("pagu-denial-observer: install seccomp user-notif listener");
    stop_child(child);
    fclose(log);
    free(rules);
    return 1;
  }
  int child_status = supervise(listener_fd, child, log, rules, denied_count,
                               profile);
  if (child_status < 0) {
    perror("pagu-denial-observer: supervise denial evidence");
    stop_child(child);
  }
  close(listener_fd);
  if (fclose(log) < 0) {
    perror("pagu-denial-observer: close log");
    child_status = -1;
  }
  free(rules);
  if (child_status < 0) return 1;
  if (WIFEXITED(child_status)) return WEXITSTATUS(child_status);
  if (WIFSIGNALED(child_status)) {
    int signal_number = WTERMSIG(child_status);
    signal(signal_number, SIG_DFL);
    raise(signal_number);
    return 128 + signal_number;
  }
  return 1;
}
#endif
