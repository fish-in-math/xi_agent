import os
import sys
from typing import Optional

from dotenv import load_dotenv

try:
    from cozepy import Coze, TokenAuth, Message, ChatEventType, COZE_CN_BASE_URL
except ImportError as e:
    print(
        "Missing dependencies. Please install with: pip install -r requirements.txt",
        file=sys.stderr,
    )
    raise


def get_env(name: str, default: Optional[str] = None) -> Optional[str]:
    value = os.getenv(name)
    if value is None or value == "":
        return default
    return value


def init_client() -> Coze:
    # Prefer values from .env if present
    load_dotenv(override=False)

    token = get_env("COZE_API_TOKEN")
    if not token:
        print(
            "ERROR: COZE_API_TOKEN not set. Copy .env.example to .env and fill values."
        )
        sys.exit(1)

    base_url = get_env("COZE_API_BASE") or COZE_CN_BASE_URL
    return Coze(auth=TokenAuth(token), base_url=base_url)


def stream_answer(
    coze: Coze, bot_id: str, user_id: str, conversation_id: Optional[str], question: str
) -> str:
    full_text = []
    for event in coze.chat.stream(
        bot_id=bot_id,
        user_id=user_id,
        additional_messages=[Message.build_user_question_text(question)],
        conversation_id=conversation_id,
    ):
        if event.event == ChatEventType.CONVERSATION_MESSAGE_DELTA:
            chunk = event.message.content or ""
            full_text.append(chunk)
            print(chunk, end="", flush=True)
        elif event.event == ChatEventType.CONVERSATION_CHAT_COMPLETED:
            usage = getattr(event.chat.usage, "token_count", None)
            if usage is not None:
                print(f"\n[token usage: {usage}]")
            else:
                print()
    return "".join(full_text)


def main() -> None:
    coze = init_client()

    bot_id = get_env("COZE_BOT_ID")
    if not bot_id:
        print("ERROR: COZE_BOT_ID not set. Fill it in your .env.")
        sys.exit(1)

    # Support both COZE_USER_ID and COZE_DEFAULT_USER_ID for compatibility
    user_id = get_env("COZE_USER_ID") or get_env("COZE_DEFAULT_USER_ID", "local_user")

    # Create a conversation to preserve context across turns
    conversation = coze.conversations.create()
    conv_id = conversation.id

    print("Simple Coze Chat (type 'exit' to quit)")
    while True:
        try:
            question = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nBye.")
            break
        if question.lower() in {"exit", "quit", ":q"}:
            print("Bye.")
            break
        if not question:
            continue

        print("Bot:", end=" ")
        try:
            _ = stream_answer(coze, bot_id, user_id, conv_id, question)
        except Exception as e:
            # Print SDK response logid when available to help debugging
            logid = getattr(getattr(e, "response", None), "logid", None)
            if logid:
                print(f"\nError: {e} (logid={logid})")
            else:
                print(f"\nError: {e}")


if __name__ == "__main__":
    main()
