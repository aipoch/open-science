// Desktop's crash exception ports are inherited across exec. An independently running
// service must release them before Node starts or any of its children can inherit them.
#include <mach/mach.h>
#include <mach/machine/thread_status.h>
#include <servers/bootstrap.h>
#include <stdio.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 2 || argv[1][0] != '/') {
    fputs("An absolute Node executable path is required.\n", stderr);
    return 1;
  }

  // Match CrashpadClient::UseSystemDefaultHandler. From macOS 13 onward
  // guard exceptions are delivered as EXC_CRASH.
  exception_mask_t mask = EXC_MASK_CRASH | EXC_MASK_RESOURCE | EXC_MASK_GUARD;
  if (__builtin_available(macOS 13.0, *)) {
    mask &= ~EXC_MASK_GUARD;
  }
  mach_port_t system_handler = MACH_PORT_NULL;
  kern_return_t kr = bootstrap_look_up(bootstrap_port, "com.apple.ReportCrash", &system_handler);
  if (kr == KERN_SUCCESS) {
    kr = task_set_exception_ports(mach_task_self(), mask, system_handler,
                                  EXCEPTION_STATE_IDENTITY | MACH_EXCEPTION_CODES,
                                  MACHINE_THREAD_STATE);
    mach_port_deallocate(mach_task_self(), system_handler);
  }
  if (kr != KERN_SUCCESS) {
    kr = task_set_exception_ports(mach_task_self(), mask, MACH_PORT_NULL,
                                  EXCEPTION_STATE_IDENTITY | MACH_EXCEPTION_CODES,
                                  MACHINE_THREAD_STATE);
  }
  if (kr != KERN_SUCCESS) {
    fprintf(stderr, "Cannot reset inherited crash exception ports: %s\n", mach_error_string(kr));
    return 1;
  }

  execv(argv[1], &argv[1]);
  perror("Cannot execute the desktop service");
  return 1;
}
