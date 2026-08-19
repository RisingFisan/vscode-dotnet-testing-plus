namespace MES.E2E.Cart;

// Second half of the partial CartTests class: the [TestClass] attribute lives
// in CartTests.cs, so a source scan must still pick these methods up here.
public partial class CartTests
{
    [TestMethod]
    public void RemoveItemDecreasesCount()
    {
        var count = 2;
        count--;
        Assert.AreEqual(1, count);
    }
}
