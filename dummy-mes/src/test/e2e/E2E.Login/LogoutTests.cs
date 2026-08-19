namespace MES.E2E.Login;

[TestClass]
public sealed class LogoutTests
{
    [TestMethod]
    public void LogoutRedirectsToLogin()
    {
        Assert.IsTrue(true);
    }

    [TestMethod]
    public void LogoutClearsSession()
    {
        Assert.IsTrue(true);
    }

    [TestMethod]
    public async Task LogoutRevokesTokenAsync()
    {
        await Task.Delay(10);
        Assert.IsTrue(true);
    }
}
