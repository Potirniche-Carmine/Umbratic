using App.Storage;

namespace App.Api
{
    public class Service
    {
        public int CreateUser(int value) { return new Store().Save(value); }
    }
}
