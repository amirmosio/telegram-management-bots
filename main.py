import asyncio
from common.client import get_client, start_client
from tasks import ALL_TASKS


async def main():
    client = get_client()
    await start_client(client)
    print("Connected to Telegram.\n")

    print("Available tasks:")
    for i, task_cls in enumerate(ALL_TASKS, 1):
        print(f"  {i}. {task_cls.name} - {task_cls.description}")
    print()

    choice = input("Select a task number (or 'q' to quit): ").strip()
    if choice.lower() == "q":
        return

    idx = int(choice) - 1
    if idx < 0 or idx >= len(ALL_TASKS):
        print("Invalid choice.")
        return

    task = ALL_TASKS[idx](client)
    print(f"\nRunning: {task.name}\n")
    await task.run()

    await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
