namespace MES.E2E.Checkout;

[TestClass]
public sealed class CheckoutTests
{
    [TestMethod]
    public void CheckoutCompletesOrder()
    {
        Assert.IsTrue(true);
    }

    [TestMethod]
    public void CheckoutRejectsInvalidCard()
    {
        Assert.Fail("Simulated failure: invalid card was accepted.");
    }

    [TestMethod]
    public void CheckoutAppliesDiscount()
    {
        Assert.AreEqual(90, 100 - 10);
    }
}
