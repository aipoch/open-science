// A satisfied path alone can still be metered or in Low Data Mode.
#include <Network/Network.h>
#include <stdlib.h>

int main(void) {
    nw_path_monitor_t monitor = nw_path_monitor_create();
    nw_path_monitor_set_queue(monitor, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
    nw_path_monitor_set_update_handler(monitor, ^(nw_path_t path) {
        _Exit(nw_path_get_status(path) == nw_path_status_satisfied &&
              !nw_path_is_expensive(path) && !nw_path_is_constrained(path) ? 0 : 1);
    });
    nw_path_monitor_start(monitor);
    dispatch_main();
}
