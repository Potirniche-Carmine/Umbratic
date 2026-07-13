from store import save
def create_user(name: str):
    return save({"name": name})
