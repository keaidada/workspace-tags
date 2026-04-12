import json
import os
import struct
import sys
import time


HOST_NAME = 'com.workspace_tags.native_host'
HOST_VERSION = '1.0.0'
HOST_DEBUG = os.environ.get('WORKSPACE_TAGS_HOST_DEBUG') == '1'
MAX_MESSAGE_BYTES = 10 * 1024 * 1024
MAX_RESPONSE_BYTES = 1024 * 1024
MAX_PATH_LENGTH = 4096
MAX_BATCH_PATHS = 1000
MAX_TAG_PATHS = 2000
MAX_FILE_MOVES = 5000
MAX_PAGE_VALUE = 100000


class ValidationError(Exception):
    def __init__(self, message, code='INVALID_PARAMS'):
        super().__init__(message)
        self.code = code



def log_stderr(message, level='INFO', always=False):
    if not always and not HOST_DEBUG:
        return
    timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
    sys.stderr.write(f"[{timestamp}] [{level}] {message}\n")
    sys.stderr.flush()



def error_response(message, code='HOST_ERROR', **extra):
    response = {
        'error': message,
        'errorCode': code,
    }
    response.update(extra)
    return response



def _ensure_result_dict(result):
    if isinstance(result, dict):
        return result
    return {'result': result}



def _normalize_action_result(action, result):
    result = _ensure_result_dict(result)
    if result.get('error'):
        result.setdefault('errorCode', 'ACTION_FAILED')
        result.setdefault('action', action)
    return result



def _require_string(value, field_name, allow_empty=False, max_length=MAX_PATH_LENGTH):
    if not isinstance(value, str):
        raise ValidationError(f'参数 {field_name} 必须是字符串')
    if not allow_empty and not value.strip():
        raise ValidationError(f'参数 {field_name} 不能为空')
    if len(value) > max_length:
        raise ValidationError(f'参数 {field_name} 过长（超过 {max_length} 个字符）')
    return value



def _optional_string(value, field_name, default='', max_length=MAX_PATH_LENGTH):
    if value is None:
        return default
    if not isinstance(value, str):
        raise ValidationError(f'参数 {field_name} 必须是字符串')
    if len(value) > max_length:
        raise ValidationError(f'参数 {field_name} 过长（超过 {max_length} 个字符）')
    return value



def _optional_bool(value, field_name, default=False):
    if value is None:
        return default
    if not isinstance(value, bool):
        raise ValidationError(f'参数 {field_name} 必须是布尔值')
    return value



def _optional_non_negative_int(value, field_name, default=0, max_value=MAX_PAGE_VALUE):
    if value is None:
        return default
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValidationError(f'参数 {field_name} 必须是整数')
    if value < 0:
        raise ValidationError(f'参数 {field_name} 不能小于 0')
    if value > max_value:
        raise ValidationError(f'参数 {field_name} 过大（最大 {max_value}）')
    return value



def _require_list(value, field_name, max_items=None):
    if not isinstance(value, list):
        raise ValidationError(f'参数 {field_name} 必须是数组')
    if max_items is not None and len(value) > max_items:
        raise ValidationError(f'参数 {field_name} 数量超过上限（最大 {max_items}）')
    return value



def _require_string_list(value, field_name, max_items=None, allow_empty_items=False, max_length=MAX_PATH_LENGTH):
    items = _require_list(value, field_name, max_items=max_items)
    validated = []
    for idx, item in enumerate(items):
        validated.append(_require_string(item, f'{field_name}[{idx}]', allow_empty=allow_empty_items, max_length=max_length))
    return validated



def read_message():
    """从 stdin 读取 Chrome Native Messaging 格式的消息"""
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) == 0:
        sys.exit(0)
    if len(raw_length) != 4:
        raise RuntimeError('读取消息头失败：长度不足 4 字节')

    message_length = struct.unpack('=I', raw_length)[0]
    if message_length > MAX_MESSAGE_BYTES:
        raise RuntimeError(f'消息过大：{message_length} 字节')

    raw_message = sys.stdin.buffer.read(message_length)
    if len(raw_message) != message_length:
        raise RuntimeError(f'消息体不完整：期望 {message_length} 字节，实际 {len(raw_message)} 字节')

    try:
        message = raw_message.decode('utf-8')
    except UnicodeDecodeError as exc:
        raise RuntimeError(f'消息不是有效的 UTF-8：{exc}') from exc

    try:
        payload = json.loads(message)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f'消息不是有效的 JSON：{exc}') from exc

    if not isinstance(payload, dict):
        raise RuntimeError('消息体必须是 JSON 对象')

    return payload



def send_message(message):
    """向 stdout 写入 Chrome Native Messaging 格式的消息"""
    encoded = json.dumps(message, ensure_ascii=False).encode('utf-8')
    if len(encoded) > MAX_RESPONSE_BYTES:
        log_stderr(f'Response too large ({len(encoded)} bytes), returning compact error', 'WARN', always=True)
        error_msg = json.dumps(
            error_response(
                f'响应数据过大 ({len(encoded)} 字节)，请尝试选择更小的目录或子目录',
                code='RESPONSE_TOO_LARGE',
            ),
            ensure_ascii=False,
        ).encode('utf-8')
        sys.stdout.buffer.write(struct.pack('=I', len(error_msg)))
        sys.stdout.buffer.write(error_msg)
        sys.stdout.buffer.flush()
        return
    sys.stdout.buffer.write(struct.pack('=I', len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()
