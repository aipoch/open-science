"""Inspect portable xattrs and restore metadata omitted by ditto, without following links."""

import ctypes
import hashlib
import json
import os
import stat
import sys

libc = ctypes.CDLL(None, use_errno=True)
libc.listxattr.argtypes = [ctypes.c_char_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int]
libc.listxattr.restype = ctypes.c_ssize_t
libc.getxattr.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p,
                        ctypes.c_size_t, ctypes.c_uint32, ctypes.c_int]
libc.getxattr.restype = ctypes.c_ssize_t
libc.setxattr.argtypes = libc.getxattr.argtypes
libc.setxattr.restype = ctypes.c_int
NOFOLLOW = 1


def checked(result, path):
    if result < 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), path)
    return result


def attributes(path):
    encoded = os.fsencode(path)
    size = checked(libc.listxattr(encoded, None, 0, NOFOLLOW), path)
    names = ctypes.create_string_buffer(size)
    count = checked(libc.listxattr(encoded, names, size, NOFOLLOW), path)
    result = {}
    for name in sorted(names.raw[:count].split(b'\0')):
        # macOS stamps this process-provenance marker on copies, chmod and even setxattr.
        # Do not forge or remove it. Quarantine, signatures, FinderInfo and user xattrs remain exact.
        if not name or name == b'com.apple.provenance':
            continue
        size = checked(libc.getxattr(encoded, name, None, 0, 0, NOFOLLOW), path)
        value = ctypes.create_string_buffer(size)
        count = checked(libc.getxattr(encoded, name, value, size, 0, NOFOLLOW), path)
        result[name] = value.raw[:count]
    return result


def nodes(root, relative=''):
    path = os.path.join(root, relative) if relative else root
    info = os.lstat(path)
    yield relative, path, info
    if stat.S_ISDIR(info.st_mode):
        for name in sorted(os.listdir(path)):
            yield from nodes(root, os.path.join(relative, name))


def inspect(root):
    digest = hashlib.sha256()
    for relative, path, _ in nodes(root):
        for name, value in attributes(path).items():
            # JSON framing keeps arbitrary names, separators and binary values unambiguous.
            digest.update(json.dumps([relative, os.fsdecode(name), value.hex()],
                                     ensure_ascii=True).encode() + b'\n')
    print(digest.hexdigest())


def repair(source, target):
    modes = []
    for relative, path, original in nodes(source):
        destination = os.path.join(target, relative) if relative else target
        copied = os.lstat(destination)
        if (stat.S_IFMT(original.st_mode), original.st_uid, original.st_gid) != (
                stat.S_IFMT(copied.st_mode), copied.st_uid, copied.st_gid):
            raise RuntimeError('Copy type or ownership mismatch: ' + destination)
        current = attributes(destination)
        for name, value in attributes(path).items():
            if current.get(name) != value:
                checked(libc.setxattr(os.fsencode(destination), name, value,
                                      len(value), 0, NOFOLLOW), destination)
        if not stat.S_ISLNK(original.st_mode) and stat.S_IMODE(original.st_mode) != stat.S_IMODE(copied.st_mode):
            modes.append((destination, stat.S_IMODE(original.st_mode), copied.st_dev, copied.st_ino))
    # Restore restrictive directory permissions last. Never chmod a symlink or a replacement inode.
    for destination, mode, device, inode in reversed(modes):
        fd = os.open(destination, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            current = os.fstat(fd)
            if (current.st_dev, current.st_ino) != (device, inode):
                raise RuntimeError('Copy changed before restoring permissions: ' + destination)
            os.fchmod(fd, mode)
        finally:
            os.close(fd)


if __name__ == '__main__':
    if sys.argv[1] == 'inspect':
        inspect(sys.argv[2])
    elif sys.argv[1] == 'repair':
        repair(sys.argv[2], sys.argv[3])
    else:
        raise ValueError('Unknown metadata operation')
