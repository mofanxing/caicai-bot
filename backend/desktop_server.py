"""Desktop-owned API process. The stdin pipe is a lease held by Electron."""

import argparse
import logging
import os
import signal
import sys
import threading


def report(code):
    print(f"CAICAI_BACKEND_ERROR={code}", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", choices=["127.0.0.1", "localhost"], required=True)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    # Never forward raw validation errors, credentials or user messages to the desktop.
    logging.disable(logging.CRITICAL)
    try:
        import uvicorn
        from pydantic import ValidationError

        from app.main import create_app
    except ImportError:
        report("dependencies_missing")
        return 1
    try:
        app = create_app()
    except ValidationError:
        report("config_invalid")
        return 1
    except Exception:
        report("startup_failed")
        return 1
    app.state.manage_task_worker = True
    app.state.desktop_run_id = os.environ.get("CAICAI_DESKTOP_RUN_ID", "")
    server = uvicorn.Server(uvicorn.Config(
        app, host=args.host, port=args.port, log_config=None, access_log=False,
        timeout_graceful_shutdown=5,
    ))
    finished = threading.Event()

    def watch_parent():
        # EOF also arrives on Electron crashes / SIGKILL, when JS cleanup cannot run.
        try:
            while sys.stdin.buffer.read(1):
                pass
        finally:
            server.should_exit = True
            # Bound cleanup even if shutdown is stuck in a model request or TTS worker.
            if not finished.wait(10):
                if os.name == "posix" and os.getpgrp() == os.getpid():
                    os.killpg(os.getpgrp(), signal.SIGKILL)
                else:
                    os._exit(1)

    threading.Thread(target=watch_parent, daemon=True, name="desktop-lease").start()
    try:
        server.run()
        if not server.started:
            report("startup_failed")
            return 1
        return 0
    except (Exception, SystemExit):
        report("startup_failed")
        return 1
    finally:
        finished.set()


if __name__ == "__main__":
    raise SystemExit(main())
