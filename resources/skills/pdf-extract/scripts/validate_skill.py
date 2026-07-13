#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Minimal validation entrypoint for audit verification."""

from __future__ import annotations

import argparse


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Validation helper for this skill. Use it to confirm the local script path is available before full execution."
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Return a success message confirming the validation helper is available.",
    )
    args = parser.parse_args()
    if args.check:
        print("validation-helper: ok")


if __name__ == "__main__":
    main()
